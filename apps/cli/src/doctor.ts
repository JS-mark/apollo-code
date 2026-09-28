import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { productIdentity } from '@volund/shared'
import { TaskStore } from '@volund/storage'

import { readDaemonStatus, taskStorePath } from './daemon'
import type { VolundPorts, DoctorHealth, PluginAvailability } from './ports'

const execFileAsync = promisify(execFile)
const GH_VERSION_TIMEOUT_MS = 5 * 1e3
/** r13-G6: hint mirrors CONTRIBUTING "Recommended" deps — gh only powers the PR workflow. */
export const GH_CLI_MISSING_HINT = 'PR 工作流需要 gh（CONTRIBUTING 推荐依赖）'

export interface GhCliHealth {
  installed: boolean
  path?: string
  version?: string
}
export interface DoctorCheck {
  detail: string
  /** Structured gh CLI availability for --json consumers (r13-G6). */
  gh?: GhCliHealth
  name: string
  ok: boolean
  /** Structured production plugin containment disclosure. */
  plugin?: PluginAvailability
  /** Warn-only check: rendered ⚠️ and never trips --strict (r13-G6). */
  warn?: boolean
}
export async function detectGhCli(env: NodeJS.ProcessEnv = process.env): Promise<GhCliHealth> {
  const path = await resolveExecutablePath('gh', env)
  if (!path) return { installed: false }
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      env,
      timeout: GH_VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    const version = /gh version (\S+)/.exec(stdout)?.[1]
    return version ? { installed: true, path, version } : { installed: false }
  } catch {
    return { installed: false }
  }
}
async function resolveExecutablePath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const searchPath = env.PATH ?? env.Path
  if (!searchPath) return undefined
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue
    for (const candidate of candidates) {
      const full = join(directory, candidate)
      try {
        await access(full, constants.X_OK)
        return full
      } catch {
        // Keep scanning the PATH entries.
      }
    }
  }
  return undefined
}
interface SkillsHealth {
  total: number
  broken: number
  disabled: number
  error?: string
}
interface McpHealth {
  total: number
  connected: number
  failed: number
  error?: string
}
export async function runDoctor(
  cwd: string,
  ports: VolundPorts,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorCheck[]> {
  const [native, auth, config, telemetry, gh, plugin, evolution, skillsHealth, mcpHealth] =
    await Promise.all([
      ports.native.health(),
      ports.auth.health(),
      ports.config.health(cwd),
      ports.telemetry.health(),
      detectGhCli(env),
      ports.plugin?.availability(),
      ports.evolution?.health?.().catch(
        (error): DoctorHealth => ({
          valid: false,
          detail: `evolution health check failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ),
      ports.skill?.list().then(
        (skills): SkillsHealth => ({
          total: skills.length,
          broken: skills.filter((skill) => skill.status === 'broken').length,
          disabled: skills.filter((skill) => skill.status === 'disabled').length,
        }),
        (error): SkillsHealth => ({
          total: 0,
          broken: 0,
          disabled: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      ports.mcp?.list().then(
        (servers): McpHealth => ({
          total: servers.length,
          connected: servers.filter((server) => server.status === 'connected').length,
          failed: servers.filter(
            (server) => server.status === 'failed' || server.status === 'needs-auth',
          ).length,
        }),
        (error): McpHealth => ({
          total: 0,
          connected: 0,
          failed: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ])
  let writable = true
  try {
    await access(cwd, constants.W_OK)
  } catch {
    writable = false
  }
  // W-17 调度健康面：enabled 未开=正常（默认关闭）；开了但 daemon 不在场=⚠️
  // （任务不会触发——这是 7x24 语义下最需要可观测的状态）。
  let schedulerCheck: DoctorCheck
  try {
    const home = env.VOLUND_HOME ?? join(homedir(), '.volund')
    const merged = await ports.config.listMerged?.({ cwd }).catch(() => undefined)
    const tasksSection = (merged?.config?.['tasks'] ?? {}) as { enabled?: unknown }
    const enabled = tasksSection['enabled'] === true
    const taskCount = enabled ? (await new TaskStore(taskStorePath(home)).listTasks()).length : 0
    const daemonStatus = enabled ? await readDaemonStatus(home) : { running: false }
    schedulerCheck =
      enabled && !daemonStatus.running
        ? {
            name: 'task scheduler',
            ok: true,
            warn: true,
            detail: 'enabled but no daemon is running; tasks will not fire (start `volund daemon`)',
          }
        : {
            name: 'task scheduler',
            ok: true,
            detail: !enabled
              ? 'disabled ([tasks].enabled)'
              : `daemon running (pid ${daemonStatus.pid}), ${taskCount} task(s)`,
          }
  } catch (error) {
    schedulerCheck = {
      name: 'task scheduler',
      ok: false,
      detail: `scheduler health check failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return [
    {
      name: 'node version',
      ok: Number(process.versions.node.split('.')[0]) >= 20,
      detail: process.versions.node,
    },
    { name: `${productIdentity.commandName} version`, ok: true, detail: ports.identity.version },
    {
      name: 'native sandbox',
      ok: native.sandbox,
      detail: native.sandbox ? 'available' : 'native sandbox unavailable',
    },
    {
      name: 'native search',
      ok: native.search,
      detail: native.search ? 'available' : 'native search unavailable',
    },
    { name: 'native fs', ok: native.fs, detail: native.fs ? 'available' : 'native fs unavailable' },
    { name: 'auth', ok: auth.configured === true, detail: auth.detail },
    { name: 'config', ok: config.valid === true, detail: config.detail },
    // §15.11 T1b: journal recovery is surfaced here but never fails doctor —
    // tuning stays default-off and reads remain available.
    ...(evolution
      ? [
          {
            name: 'evolution tuning store',
            ok: true,
            ...(evolution.valid === false ? { warn: true } : {}),
            detail: evolution.detail,
          } satisfies DoctorCheck,
        ]
      : []),
    { name: 'cwd writable', ok: writable, detail: cwd },
    {
      detail: gh.installed ? `${gh.version} (${gh.path})` : GH_CLI_MISSING_HINT,
      gh,
      name: 'gh CLI',
      // Warn-only (r13-G6): a missing gh never fails doctor, not even with --strict.
      ok: true,
      ...(gh.installed ? {} : { warn: true }),
    },
    ...(plugin
      ? [
          {
            name: 'plugin activation',
            ok: true,
            warn: true,
            detail: `${plugin.detail} Reopen requires ${plugin.reopenCondition}.`,
            plugin,
          } satisfies DoctorCheck,
        ]
      : []),
    // SKILLS-MCPS-r1：skills 与 mcp 的健康面（list 失败 / broken skill → fail;
    // 断开/未配置 → 只读状态行,不影响 doctor 结论）。
    {
      name: 'skills',
      ok: !skillsHealth?.error && (skillsHealth?.broken ?? 0) === 0,
      detail: skillsHealth?.error
        ? `skill discovery failed: ${skillsHealth.error}`
        : `${skillsHealth?.total ?? 0} installed${skillsHealth && skillsHealth.broken > 0 ? `, ${skillsHealth.broken} broken` : ''}${skillsHealth && skillsHealth.disabled > 0 ? `, ${skillsHealth.disabled} disabled` : ''}`,
    },
    {
      name: 'mcp servers',
      ok: !mcpHealth?.error && (mcpHealth?.failed ?? 0) === 0,
      detail: mcpHealth?.error
        ? `mcp discovery failed: ${mcpHealth.error}`
        : `${mcpHealth?.total ?? 0} configured${mcpHealth && mcpHealth.connected > 0 ? `, ${mcpHealth.connected} connected` : ''}${mcpHealth && mcpHealth.failed > 0 ? `, ${mcpHealth.failed} failed/needs-auth` : ''}`,
    },
    {
      name: 'local telemetry',
      ok: telemetry.writable && telemetry.corruptLines === 0,
      detail: telemetry.detail,
    },
    schedulerCheck,
  ]
}
