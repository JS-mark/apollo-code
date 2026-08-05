import { sanitize, validateWorkspacePath } from '@apollo-code/shared'
import {
  renderPrivacyDisclosure,
  renderSandboxDisclosure,
  renderSecurityBanner,
  renderTelemetryPanel,
} from '@apollo-code/ui'
import type { DangerousMode } from '@apollo-code/ui'
import { parseArgs, renderUsage } from 'citty'

import { command } from './command'
import { runDoctor } from './doctor'
import type { ApolloPorts } from './ports'

export interface CliResult {
  exitCode: number
  stderr: string
  stdout: string
}
const argsDefinition = {
  cwd: { type: 'string' as const },
  json: { type: 'boolean' as const },
  noColor: { type: 'boolean' as const },
  noTui: { type: 'boolean' as const },
  strict: { type: 'boolean' as const },
  strictSandbox: { type: 'boolean' as const },
  dangerousNoSandbox: { type: 'boolean' as const },
  dangerouslySkipPermissions: { type: 'boolean' as const },
  yolo: { type: 'boolean' as const },
  apiKeyStdin: { type: 'boolean' as const },
  skipVerify: { type: 'boolean' as const },
  dangerous: { type: 'boolean' as const },
  dryRun: { type: 'boolean' as const },
  namespace: { type: 'string' as const },
  since: { type: 'string' as const },
  to: { type: 'string' as const },
}
export interface CliIo {
  readStdin(): Promise<string>
}
const defaultIo: CliIo = {
  async readStdin() {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  },
}
export async function runCli(
  rawArgs: string[],
  ports: ApolloPorts,
  io: CliIo = defaultIo,
): Promise<CliResult> {
  const args = parseArgs(rawArgs, argsDefinition)
  const subcommand = args._[0]
  let stdout = ''
  let stderr = ''
  const jsonMode = Boolean(args.json)
  let cwd: string
  try {
    cwd = await validateWorkspacePath(String(args.cwd ?? process.cwd()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonMode
      ? jsonFailure(message, 1, 'invalid_workspace')
      : { exitCode: 1, stdout, stderr: message }
  }
  const dangerousModes: DangerousMode[] = []
  if (args.yolo || args.dangerouslySkipPermissions) {
    dangerousModes.push('skip-permissions')
    await ports.telemetry.securityEvent('permissions.dangerously_skipped', { cwd })
  }
  if (args.dangerousNoSandbox) {
    dangerousModes.push('no-sandbox')
    await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
    if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
      return {
        exitCode: 1,
        stdout,
        stderr: 'Dangerous no-sandbox mode requires typing: I understand the risk',
      }
  }
  const probe = await ports.native.probe()
  const startsSession = subcommand === undefined || subcommand === 'chat'
  if (!jsonMode) {
    if (startsSession) stdout += `${renderPrivacyDisclosure()}\n`
    stdout += `${renderSandboxDisclosure(probe)}\n`
  }
  if (args.strictSandbox && probe.tier !== 'full') {
    const message = `Full sandbox required; detected ${probe.tier}.`
    return jsonMode
      ? jsonFailure(message, 3, 'sandbox_unavailable')
      : { exitCode: 3, stdout, stderr: message }
  }
  if (startsSession && probe.tier === 'none' && !args.dangerousNoSandbox) {
    await ports.telemetry.securityEvent('sandbox.probe.failed', { cwd, mechanism: probe.mechanism })
    if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
      return {
        exitCode: 1,
        stdout,
        stderr: 'None-tier sandbox requires typing: I understand the risk',
      }
    dangerousModes.push('no-sandbox')
    await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
  }
  const banner = renderSecurityBanner(dangerousModes, !args.noColor)
  if (banner) stdout += `${banner}\n`
  ports.session.configureSecurity?.({
    skipPermissions: Boolean(args.yolo || args.dangerouslySkipPermissions),
  })
  ports.session.configureOutput?.({ json: jsonMode, write: (value) => (stdout += value) })
  if (subcommand === 'doctor') {
    const checks = await runDoctor(cwd, ports)
    stdout += args.json
      ? `${JSON.stringify(checks)}\n`
      : `${checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n')}\n`
    return { exitCode: args.strict && checks.some((check) => !check.ok) ? 1 : 0, stdout, stderr }
  }
  if (subcommand === 'telemetry') {
    const action = args._[1] ?? 'show'
    if (action === 'show') {
      const summary = await ports.telemetry.summary()
      stdout += `${args.json ? JSON.stringify(summary) : renderTelemetryPanel(summary)}\n`
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'export') {
      const target = args._[2]
      if (!target) return { exitCode: 2, stdout, stderr: 'telemetry export requires a target path' }
      const count = await ports.telemetry.export(target)
      return { exitCode: 0, stdout: `${stdout}Exported ${count} redacted event(s).\n`, stderr }
    }
    if (action === 'clear') {
      await ports.telemetry.clear()
      return { exitCode: 0, stdout: `${stdout}Cleared local telemetry.\n`, stderr }
    }
    return { exitCode: 2, stdout, stderr: `Unknown telemetry action: ${action}` }
  }
  if (subcommand === 'version')
    return { exitCode: 0, stdout: `${stdout}${ports.version}\n`, stderr }
  if (subcommand === 'help')
    return { exitCode: 0, stdout: `${stdout}${await renderUsage(command)}`, stderr }
  if (subcommand === 'hook' && args._[1] === 'list')
    return { exitCode: 0, stdout: `${stdout}No builtin hooks registered.\n`, stderr }
  if (subcommand === 'plugin') {
    if (!ports.plugin)
      return { exitCode: 2, stdout, stderr: 'plugin integration port is not connected' }
    const action = args._[1] ?? 'list'
    try {
      if (action === 'list') {
        const plugins = await ports.plugin.list()
        stdout += args.json
          ? `${JSON.stringify(Object.entries(plugins).map(([name, state]) => ({ name, ...state })))}\n`
          : `${Object.entries(plugins)
              .map(
                ([name, state]) =>
                  `${name}@${state.version}\t${state.enabled ? 'enabled' : 'disabled'}`,
              )
              .join('\n')}${Object.keys(plugins).length ? '\n' : ''}`
        return { exitCode: 0, stdout, stderr }
      }
      const target = args._[2]
      if (!target) return { exitCode: 2, stdout, stderr: `plugin ${action} requires a target` }
      if (action === 'install') {
        const manifest = await ports.plugin.install(target)
        return {
          exitCode: 0,
          stdout: `${stdout}Installed ${manifest.name}@${manifest.version}.\n`,
          stderr,
        }
      }
      if (action === 'uninstall') {
        await ports.plugin.uninstall(target)
        return { exitCode: 0, stdout: `${stdout}Uninstalled ${target}.\n`, stderr }
      }
      if (action === 'enable' || action === 'disable') {
        await ports.plugin.setEnabled(target, action === 'enable')
        return {
          exitCode: 0,
          stdout: `${stdout}${action === 'enable' ? 'Enabled' : 'Disabled'} ${target}.\n`,
          stderr,
        }
      }
      if (action === 'doctor') {
        const report = await ports.plugin.doctor(target)
        stdout += `${args.json ? JSON.stringify(report) : `${report.name}@${report.version}\nPermissions: ${report.permissions.join(', ') || 'none'}`}\n`
        return { exitCode: 0, stdout, stderr }
      }
      return { exitCode: 2, stdout, stderr: `Unknown plugin action: ${action}` }
    } catch (error) {
      return { exitCode: 1, stdout, stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  if (subcommand === 'mcp') {
    if (!ports.mcp) return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
    const action = args._[1] ?? 'list'
    if (action === 'list') {
      const servers = await ports.mcp.list()
      stdout += args.json
        ? `${JSON.stringify(servers)}\n`
        : `${servers.map((server) => `${server.name}\t${redactTransport(server.transport)}`).join('\n')}${servers.length ? '\n' : ''}`
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'test' || action === 'inspect') {
      const name = args._[2]
      if (!name) return { exitCode: 2, stdout, stderr: `mcp ${action} requires a server name` }
      try {
        if (action === 'test') {
          const result = await ports.mcp.test(name, AbortSignal.timeout(10_000))
          stdout += `${args.json ? JSON.stringify(result) : `Connected (${result.protocolVersion})`}\n`
        } else {
          const result = await ports.mcp.inspect(name, AbortSignal.timeout(10_000))
          stdout += `${args.json ? JSON.stringify(result) : result.tools.map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`).join('\n')}\n`
        }
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        return {
          exitCode: 1,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { exitCode: 2, stdout, stderr: `Unknown mcp action: ${action}` }
  }
  if (subcommand === 'context') {
    if (!ports.context)
      return { exitCode: 2, stdout, stderr: 'context integration port is not connected' }
    const action = args._[1] ?? 'show'
    if (action === 'show') {
      const status = await ports.context.show()
      stdout += args.json
        ? `${JSON.stringify(status)}\n`
        : `Policy: ${status.policy}\nTokens: ${status.currentTokens} / ${status.maxTokens}\nCompaction threshold: ${Math.round(status.threshold * 100)}%\nSources: ${Object.entries(
            status.sources,
          )
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}\n`
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'diff') {
      const status = await ports.context.show()
      stdout += status.lastCompaction
        ? `${status.lastCompaction.compactedMessageIds.join('\n')}\n`
        : 'No compaction recorded.\n'
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'keep' || action === 'unkeep') {
      const target = args._[2]
      if (!target)
        return { exitCode: 2, stdout, stderr: `context ${action} requires a message or turn id` }
      await ports.context[action](target)
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'compact') {
      const value = args._[2]
      if (value && value !== 'sliding' && value !== 'summary')
        return { exitCode: 2, stdout, stderr: `Unsupported context strategy: ${value}` }
      const result = await ports.context.compact(value as 'sliding' | 'summary' | undefined)
      return {
        exitCode: 0,
        stdout: `${stdout}Compacted: ${result.beforeTokens} → ${result.afterTokens} tokens\n`,
        stderr,
      }
    }
    if (action === 'policy' && (args._[2] ?? 'get') === 'get') {
      const policy = await ports.context.getPolicy()
      return {
        exitCode: 0,
        stdout: `${stdout}${args.json ? JSON.stringify(policy) : `${policy.name} ${JSON.stringify(policy.params)}`}\n`,
        stderr,
      }
    }
    if (action === 'policy' && args._[2] === 'set') {
      const name = args._[3]
      if (!name) return { exitCode: 2, stdout, stderr: 'context policy set requires a name' }
      const params = Object.fromEntries(
        args._.slice(4).map((entry) => {
          const [key, ...rest] = entry.split('=')
          return [key!, rest.join('=')]
        }),
      )
      await ports.context.setPolicy(name, params)
      return { exitCode: 0, stdout, stderr }
    }
    return { exitCode: 2, stdout, stderr: `Unknown context action: ${action}` }
  }
  if (subcommand === 'evolution') {
    if (!ports.evolution)
      return { exitCode: 2, stdout, stderr: 'evolution integration port is not connected' }
    const action = args._[1] ?? 'show'
    const namespace = args.namespace ? String(args.namespace) : undefined
    const namespaces = ['context', 'router', 'retry', 'tool-timeout'] as const
    if (namespace && !namespaces.includes(namespace as (typeof namespaces)[number]))
      return { exitCode: 2, stdout, stderr: `Unsupported evolution namespace: ${namespace}` }
    if (action === 'show') {
      const records = await ports.evolution.show({
        ...(namespace ? { namespace } : {}),
        ...(args.since ? { since: new Date(String(args.since)) } : {}),
      })
      stdout += args.json
        ? `${JSON.stringify(records)}\n`
        : records.length
          ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
          : 'No evolution adjustments recorded.\n'
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'rollback') {
      const records = await ports.evolution.rollback({
        namespace: (namespace as (typeof namespaces)[number] | undefined) ?? 'context',
        ...(args.to ? { to: new Date(String(args.to)) } : {}),
      })
      stdout += `Rolled back ${records.length} parameter(s).\n`
      return { exitCode: 0, stdout, stderr }
    }
    return { exitCode: 2, stdout, stderr: `Unknown evolution action: ${action}` }
  }
  if (subcommand === 'resume') {
    const id = args._[1]
    if (!id) return { exitCode: 2, stdout, stderr: 'resume requires a session id' }
    await ports.session.resume(id)
    return { exitCode: 0, stdout, stderr }
  }
  if (subcommand === 'restore') {
    const id = args._[1]
    if (!id) return { exitCode: 2, stdout, stderr: 'restore requires a session id' }
    if (!ports.restore)
      return { exitCode: 2, stdout, stderr: 'restore integration port is not connected' }
    try {
      const restored = await ports.restore.restore(id, { dryRun: Boolean(args.dryRun) })
      if (restored.missing)
        return { exitCode: 1, stdout, stderr: `No backups found for session: ${id}` }
      if (restored.conflicts.length)
        return {
          exitCode: 1,
          stdout,
          stderr: `Restore refused because files changed after the session:\n${restored.conflicts.join('\n')}`,
        }
      stdout += `${restored.dryRun ? 'Would restore' : 'Restored'} ${restored.restored.length} file(s)\n`
      for (const path of restored.restored) stdout += `${path}\n`
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      return { exitCode: 1, stdout, stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  if (subcommand === 'login') {
    const provider = args._[1] ?? 'anthropic'
    if (provider !== 'anthropic')
      return { exitCode: 2, stdout, stderr: `Unsupported provider: ${provider}` }
    if (args.skipVerify && !args.dangerous)
      return { exitCode: 2, stdout, stderr: '--skip-verify requires --dangerous' }
    const credential = args.apiKeyStdin ? (await io.readStdin()).trim() : undefined
    if (args.apiKeyStdin && !credential)
      return { exitCode: 2, stdout, stderr: 'No credential received on stdin' }
    try {
      const result = await ports.auth.login({
        provider,
        ...(credential === undefined ? {} : { credential }),
        flow: args.apiKeyStdin ? 'stdin' : 'api-key',
        dangerouslySkipVerify: Boolean(args.skipVerify),
      })
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Login failed',
      }
    }
  }
  if (subcommand === 'logout') {
    const provider = args._[1] ?? 'anthropic'
    try {
      const result = await ports.auth.logout(provider)
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Logout failed',
      }
    }
  }
  if (subcommand !== undefined && subcommand !== 'chat')
    return {
      exitCode: 2,
      stdout,
      stderr: `${subcommand} integration port is not connected in the L1 shell.`,
    }
  const prompt = subcommand === 'chat' ? args._.slice(1).join(' ') : args._.join(' ') || undefined
  if (jsonMode && !prompt)
    return jsonFailure('JSON chat requires a prompt.', 2, 'prompt_required', 'usage')
  try {
    const session = await ports.session.start({ cwd, ...(prompt === undefined ? {} : { prompt }) })
    return { exitCode: session.exitCode ?? 0, stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (jsonMode) {
      return jsonFailure(message, 1, 'internal_error')
    }
    return { exitCode: 1, stdout, stderr: message }
  }
}

function jsonFailure(
  message: string,
  exitCode: number,
  code: string,
  category = 'runtime',
): CliResult {
  const timestamp = new Date().toISOString()
  const data = sanitize({ code, category, retryable: false, exitCode, message })
  const error = { v: 1, type: 'error', seq: 1, sessionId: '', timestamp, data }
  const final = {
    v: 1,
    type: 'final',
    seq: 2,
    sessionId: '',
    timestamp,
    data: { status: 'error', exitCode },
  }
  return { exitCode, stdout: `${JSON.stringify(error)}\n${JSON.stringify(final)}\n`, stderr: '' }
}

function redactTransport(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
    }
    return url.toString()
  } catch {
    return value.replace(/(authorization|token|secret|key)=\S+/gi, '$1=<hidden>')
  }
}
