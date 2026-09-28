/**
 * `volund tasks` / `volund daemon` 命令族（W-17 批次 2）。
 *
 * tasks 是任务表的管理入口（CRUD + journal 查看）；daemon 是唯一的调度触发者
 * （F1-01 不隐式切换——TUI/web 只读，这里的手动命令只写任务表，不触发运行）。
 * 任务创建时冻结 configHash（F1-02）；daemon 每次运行前重算比对（F1-03）。
 */
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { TaskDefinition, TaskSchedule } from '@volund/shared'
import { validateTaskDefinition, type JsonValue, type Logger } from '@volund/shared'
import { TaskStore } from '@volund/storage'

import {
  computeConfigHash,
  createProcessTaskRunner,
  createWebhookNotifier,
  DAEMON_LOCK_FILENAME,
  taskSectionsFromConfig,
  taskStorePath,
  TaskDaemon,
} from '../daemon'
import type { CommandDefinition } from '../shared/cli-types'

export function volundHome(): string {
  return process.env.VOLUND_HOME ?? join(homedir(), '.volund')
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const INTERVAL_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** `interval:<n><ms|s|m|h>` | `daily:HH:MM` | `weekly:<sun|0-6,...>@HH:MM`。 */
export function parseScheduleSpec(spec: string): TaskSchedule {
  const intervalMatch = /^interval:(\d+)(ms|s|m|h)$/.exec(spec)
  if (intervalMatch?.[1] && intervalMatch[2]) {
    return {
      kind: 'interval',
      everyMs: Number(intervalMatch[1]) * INTERVAL_UNITS[intervalMatch[2]]!,
    }
  }
  const dailyMatch = /^daily:([01]\d|2[0-3]):([0-5]\d)$/.exec(spec)
  if (dailyMatch) return { kind: 'daily', at: `${dailyMatch[1]}:${dailyMatch[2]}` }
  const weeklyMatch = /^weekly:([a-z0-9,]+)@([01]\d|2[0-3]):([0-5]\d)$/.exec(spec)
  if (weeklyMatch?.[1] && weeklyMatch[2] && weeklyMatch[3]) {
    const weekdays = weeklyMatch[1].split(',').map((token) => {
      if (/^[0-6]$/.test(token)) return Number(token)
      if (token in WEEKDAY_NAMES) return WEEKDAY_NAMES[token]!
      throw new RangeError(`invalid weekday '${token}' in schedule spec`)
    })
    return { kind: 'weekly', weekdays, at: `${weeklyMatch[2]}:${weeklyMatch[3]}` }
  }
  throw new RangeError(
    `invalid schedule spec '${spec}' (interval:<n><ms|s|m|h> | daily:HH:MM | weekly:<days>@HH:MM)`,
  )
}

export function slugifyTaskId(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 64) || 'task'
  )
}

// citty 会把 --timeout-ms 归一成 camelCase（也可能原样保留）——两种键名都读。
function flagKeys(key: string): readonly [string, string] {
  const camel = key.replaceAll(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  return key === camel ? [key, key] : [key, camel]
}

function stringFlag(args: Record<string, unknown>, key: string): string | undefined {
  for (const candidate of flagKeys(key)) {
    const value = args[candidate]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function numberFlag(args: Record<string, unknown>, key: string): number | undefined {
  for (const candidate of flagKeys(key)) {
    const value = args[candidate]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

function jsonError(error: { code: string; message: string }): string {
  return `${JSON.stringify({ error })}\n`
}

function formatSchedule(schedule: TaskSchedule): string {
  if (schedule.kind === 'interval') return `interval every ${Math.round(schedule.everyMs / 1000)}s`
  if (schedule.kind === 'daily') return `daily at ${schedule.at}`
  return `weekly on ${schedule.weekdays.join(',')} at ${schedule.at}`
}

function newStore(): TaskStore {
  return new TaskStore(taskStorePath(volundHome()))
}

/** daemon 长驻进程的 stderr 日志（detached 运行时 stdio ignore，前台运行可见）。 */
const daemonLogger: Pick<Logger, 'info' | 'warn'> = {
  info: (message, context) => writeDaemonLine(message, context),
  warn: (message, context) => writeDaemonLine(message, context),
}

function writeDaemonLine(message: string, context?: Record<string, JsonValue>): void {
  const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : ''
  process.stderr.write(`[volund daemon] ${message}${suffix}\n`, () => undefined)
}

export const tasksCommand: CommandDefinition = {
  name: 'tasks',
  async run({ args, cwd }) {
    const store = newStore()
    const action = args._[1] ?? 'list'

    if (action === 'list') {
      const tasks = await store.listTasks()
      if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(tasks)}\n`, stderr: '' }
      if (tasks.length === 0) return { exitCode: 0, stdout: 'No tasks defined.\n', stderr: '' }
      const lines = await Promise.all(
        tasks.map(async (task) => {
          const last = (await store.recentRuns({ taskId: task.id, limit: 1 }))[0]
          const lastText = last
            ? `${last.status} @ ${new Date(last.scheduledFor).toISOString()}`
            : 'never ran'
          return `${task.enabled ? 'enabled ' : 'disabled'} ${task.id}\t${formatSchedule(task.schedule)}\t${lastText}`
        }),
      )
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }

    if (action === 'add') return addTask(args, cwd)

    if (action === 'enable' || action === 'disable') {
      const id = args._[2]
      if (!id) return { exitCode: 2, stdout: '', stderr: `tasks ${action} requires a task id` }
      const existing = await store.getTask(id)
      if (!existing) return { exitCode: 1, stdout: '', stderr: `no such task: ${id}` }
      const updated = await store.upsertTask({ ...existing, enabled: action === 'enable' })
      return {
        exitCode: 0,
        stdout: `${updated.id} ${action}d\n`,
        stderr: '',
      }
    }

    if (action === 'remove') {
      const id = args._[2]
      if (!id) return { exitCode: 2, stdout: '', stderr: 'tasks remove requires a task id' }
      const removed = await store.removeTask(id)
      if (!removed) return { exitCode: 1, stdout: '', stderr: `no such task: ${id}` }
      return { exitCode: 0, stdout: `removed ${id}\n`, stderr: '' }
    }

    if (action === 'runs') {
      const id = args._[2]
      if (!id) return { exitCode: 2, stdout: '', stderr: 'tasks runs requires a task id' }
      const runs = await store.recentRuns({ taskId: id, limit: numberFlag(args, 'limit') ?? 10 })
      if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(runs)}\n`, stderr: '' }
      if (runs.length === 0)
        return { exitCode: 0, stdout: `No runs recorded for ${id}.\n`, stderr: '' }
      const lines = runs.map((run) => {
        const detail = run.error ? ` ${run.error.code}: ${run.error.message}` : ''
        return `${new Date(run.scheduledFor).toISOString()}\t${run.status}\t${
          run.exitCode ?? '-'
        }${run.sessionId ? `\t${run.sessionId}` : ''}${detail}`
      })
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }

    return { exitCode: 2, stdout: '', stderr: `Unknown tasks action: ${action}` }
  },
}

async function addTask(
  args: Record<string, unknown> & { _: string[] },
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const name = stringFlag(args, 'name')
  const prompt = stringFlag(args, 'prompt')
  const scheduleSpec = stringFlag(args, 'schedule')
  if (!name || !prompt || !scheduleSpec) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'tasks add requires --name, --prompt and --schedule',
    }
  }
  let schedule: TaskSchedule
  try {
    schedule = parseScheduleSpec(scheduleSpec)
  } catch (error) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
  const store = newStore()
  const home = volundHome()
  const definition: TaskDefinition = {
    id: stringFlag(args, 'id') ?? slugifyTaskId(name),
    name,
    enabled: !(args.disabled === true || args.disabled === 'true'),
    prompt,
    cwd: stringFlag(args, 'cwd') ?? cwd,
    schedule,
    missedRun: stringFlag(args, 'missed') === 'run_latest' ? 'run_latest' : 'skip',
    overlap: stringFlag(args, 'overlap') === 'queue' ? 'queue' : 'skip',
    // F1-02：创建时冻结 config hash；daemon 运行前重算比对（F1-03）。
    configHash: await computeConfigHash(home),
    createdAt: Date.now(),
    ...(stringFlag(args, 'tz') ? { timezone: stringFlag(args, 'tz') } : {}),
    ...(stringFlag(args, 'model') ||
    numberFlag(args, 'timeout-ms') !== undefined ||
    numberFlag(args, 'max-retries') !== undefined
      ? {
          constraints: {
            ...(stringFlag(args, 'model') ? { model: stringFlag(args, 'model') } : {}),
            ...(numberFlag(args, 'timeout-ms') !== undefined
              ? { timeoutMs: numberFlag(args, 'timeout-ms') }
              : {}),
            ...(numberFlag(args, 'max-retries') !== undefined
              ? { maxRetries: numberFlag(args, 'max-retries') }
              : {}),
          },
        }
      : {}),
  }
  const validated = validateTaskDefinition(definition)
  if (!validated.ok) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    }
  }
  const saved = await store.upsertTask(validated.value)
  return {
    exitCode: 0,
    stdout: `created ${saved.id} (${formatSchedule(saved.schedule)}, cwd ${saved.cwd})\n`,
    stderr: '',
  }
}

export const daemonCommand: CommandDefinition = {
  name: 'daemon',
  async run({ args, ports, cwd }) {
    const merged = await ports.config.listMerged?.({ cwd }).catch(() => undefined)
    const sections = taskSectionsFromConfig(merged?.config)
    if (!sections.enabled) {
      const message =
        'Task scheduler is disabled ([tasks].enabled). Set enabled = true in the [tasks] section of your user-level config.toml.'
      return {
        exitCode: 1,
        stdout: args.json ? jsonError({ code: 'tasks_disabled', message }) : '',
        stderr: args.json ? '' : message,
      }
    }
    const home = volundHome()
    // webhook URL 每 tick 随 reloadSections 热重载：通知器每次投递时重读。
    let liveSections = sections
    const store = new TaskStore(taskStorePath(home), {
      journalRetention: sections.journalRetention,
    })
    const daemon = new TaskDaemon({
      store,
      home,
      sections,
      trust: ports.trust,
      runner: createProcessTaskRunner(),
      notifier: createWebhookNotifier({ url: () => liveSections.webhookUrl, logger: daemonLogger }),
      configHash: () => computeConfigHash(home),
      // 开关热语义：每 tick 重读 [tasks] 段；翻 false → 放锁退出（exit 0，
      // 配合 launchd SuccessfulExit=false / systemd Restart=on-failure 不空转）。
      reloadSections: async () => {
        const merged = await ports.config.listMerged?.({ cwd }).catch(() => undefined)
        liveSections = taskSectionsFromConfig(merged?.config)
        return liveSections
      },
      onDisabled: () => {
        void new Promise<void>((resolve, reject) =>
          process.stdout.write(
            'task scheduler disabled ([tasks].enabled=false); daemon exiting\n',
            (error) => (error ? reject(error) : resolve()),
          ),
        )
          .catch(() => undefined)
          .finally(() => process.exit(0))
      },
    })
    let recovered = 0
    try {
      const booted = await daemon.boot()
      recovered = booted.recovered
    } catch (error) {
      // task_daemon_running（另一 daemon 持锁）等 boot 失败：按错误协议退出。
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : String(error)
      return {
        exitCode: 1,
        stdout: code && args.json ? jsonError({ code, message }) : '',
        stderr: code && args.json ? '' : message,
      }
    }
    const firstTick = await daemon.tick().catch(() => undefined)
    daemon.start()
    // bin.ts 只在 runCli 返回后写 stdout——长驻进程必须在 await 前自行落盘。
    const lines = [
      `volund daemon started (pid ${process.pid}, max ${sections.maxConcurrent} concurrent)`,
      // 不回显 URL（常带令牌），只报在场。
      ...(sections.webhookUrl ? ['notifications: webhook configured'] : []),
      ...(recovered > 0 ? [`recovered ${recovered} interrupted run(s)`] : []),
      ...(firstTick
        ? [
            `first tick: ${firstTick.fired} fired, ${firstTick.missed} missed, ${firstTick.skipped} skipped, ${firstTick.deferred} deferred`,
          ]
        : []),
    ]
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(`${lines.join('\n')}\n`, (error) => (error ? reject(error) : resolve())),
    ).catch(() => undefined)
    // SIGTERM/SIGINT：同步放锁（bin.ts 的收尾会异步 process.exit，rmSync 抢在
    // 它前面完成；stale 回收兜底极端竞态）。
    const releaseLock = () => {
      try {
        rmSync(join(home, DAEMON_LOCK_FILENAME), { force: true })
      } catch {
        // 尽力而为：锁残留由下一次 boot 的死进程回收处理。
      }
      process.exit(0)
    }
    process.once('SIGTERM', releaseLock)
    process.once('SIGINT', releaseLock)
    // 长驻：tick 句柄有意 ref。
    await new Promise<never>(() => undefined)
    return { exitCode: 0, stdout: '', stderr: '' }
  },
}
