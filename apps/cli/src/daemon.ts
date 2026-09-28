/**
 * volund daemon — 定时任务的 7x24 宿主（W-17 / Web 计划 F1-01 用户级 daemon 路线）。
 *
 * 所有权铁律（F1-01 不隐式切换）：**只有 daemon 触发任务**。TUI/web 对任务表
 * 只读，管理走 `volund tasks`；本进程持有 `<home>/daemon.lock` 单实例锁，
 * 第二个 daemon 启动即 task_daemon_running 退出。
 *
 * 执行模型：daemon 只管钟表与 journal，每次触发 spawn 一个独立 headless 子
 * 进程（`<prompt> --json`，无 TTY → permission interaction 'none' → 无人值守
 * 默认 deny，F1-03 的核心语义免费成立）。每次运行都是全新进程：trust/config
 * 重验之外，plugin/MCP 状态天然新鲜。子进程的 NDJSON 首帧带 sessionId，
 * 回填进 journal 供 web/mobile 侧跳转 transcript。
 *
 * 停机语义（F1-04）：boot 时把 journal 里遗留的 'running' 记录改判 failed
 * （前一 daemon 死亡时在途的运行）；错过的窗口由 evaluateTick 的 bootAt 分界
 * 处理（skip / run_latest 策略）；stop() 只释放锁不杀在途子进程，daemon 进程
 * 退出后它们的 journal 记录由下一次 boot 收尸。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { evaluateTick, type TaskFire } from '@volund/app-runtime'
import { parseTomlContent } from '@volund/config'
import type { TaskDefinition } from '@volund/shared'
import { VolundError, type JsonValue, type Logger } from '@volund/shared'
import { TaskStore } from '@volund/storage'

export const DAEMON_LOCK_FILENAME = 'daemon.lock'
/** 单次运行 wall-clock 缺省上限（constraints.timeoutMs 未冻结时）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000
/** 子进程 stdout/stderr 的截尾保留量（sessionId 解析 + 失败诊断）。 */
const CHILD_OUTPUT_TAIL_BYTES = 256 * 1024
/** 单任务单 tick 最多 spawn 一个窗口；同 tick 其余到期窗口按 missed 记账（防突发风暴）。 */
const MAX_FIRES_PER_TASK_PER_TICK = 1

/* ── [tasks] 配置段解析 ──────────────────────────────────────────────────── */

export interface TaskDaemonSections {
  enabled: boolean
  maxConcurrent: number
  journalRetention: number
  /** 运行终态 webhook 通知地址；空缺 = 不通知（每次投递时重读，跟随 tick 热重载）。 */
  webhookUrl?: string
}

export function taskSectionsFromConfig(
  config: Record<string, JsonValue> | undefined,
): TaskDaemonSections {
  const tasks = config?.['tasks']
  const section = (tasks && typeof tasks === 'object' ? tasks : {}) as Record<string, unknown>
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.floor(value)))
      : fallback
  const webhookUrl = section['webhook_url']
  return {
    enabled: section['enabled'] === true,
    maxConcurrent: clamp(section['max_concurrent'], 1, 1, 8),
    journalRetention: clamp(section['journal_retention'], 200, 10, 10_000),
    ...(typeof webhookUrl === 'string' && webhookUrl !== '' ? { webhookUrl } : {}),
  }
}

/**
 * 用户级 config.toml 内容 hash（任务创建时冻结进定义，daemon 运行前重算比对）。
 *
 * [tasks] 段不参与（W-17 修订）：它整段是运维面——开关 / 并发 / journal 保留 /
 * webhook 通知地址，都不在 F1-02 冻结的任务执行语义里，改通知地址不应要求重建
 * 全部任务。解析失败时退回全文 hash（漂移判定仍然 fail closed）。
 */
export async function computeConfigHash(home: string): Promise<string> {
  let raw = ''
  try {
    raw = await readFile(join(home, 'config.toml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return createHash('sha256').update(canonicalConfigWithoutTasks(raw)).digest('hex')
}

/** 解析 → 删 [tasks] → 键序归一化后序列化；保证段落/键的书写顺序不影响 hash。 */
function canonicalConfigWithoutTasks(raw: string): string {
  try {
    const config = parseTomlContent(raw) as Record<string, JsonValue>
    delete config['tasks']
    return JSON.stringify(sortKeysDeep(config))
  } catch {
    return raw
  }
}

function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, JsonValue>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeysDeep(item)]),
    )
  }
  return value
}

/**
 * 开关驱动的 daemon 生命周期（W-17 r1.4）：enabled=true ⇒ daemon 在场。
 * detached spawn（stdio ignore、unref）——父进程（TUI/web/CLI one-shot）退出
 * 不带走它；保活仍归 launchd/systemd（7x24 语义不变）。
 */
export function spawnDetachedDaemon(
  home: string,
  options: { entry?: string; cwd: string },
): boolean {
  const entry = options?.entry ?? reexecArgv()[0]
  if (!entry) return false
  const child = spawn(process.execPath, [entry, 'daemon'], {
    // cwd 是 daemon 进程的工作区（daemonCommand 会过 validateWorkspacePath 守卫：
    // 根目录/$HOME/~/.volund//private 都拒）——由调用方传真实工作区。
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VOLUND_HOME: home },
  })
  child.unref()
  return true
}

/** SIGTERM 在场 daemon（bin.ts 信号收尾会走 process.exit，锁由 stale 回收兜底）。 */
export async function stopDaemon(home: string): Promise<boolean> {
  const status = await readDaemonStatus(home)
  if (!status.running || !status.pid) return false
  process.kill(status.pid, 'SIGTERM')
  return true
}

export interface DaemonSwitchSync {
  started?: boolean
  stopped?: boolean
  alreadyRunning?: boolean
}

/** tasks.enabled 翻转后的联动：true 补拉（在场即 no-op），false 停掉。 */
export async function syncDaemonWithSwitch(
  home: string,
  enabled: boolean,
  options: { entry?: string; cwd: string },
): Promise<DaemonSwitchSync> {
  const status = await readDaemonStatus(home)
  if (enabled) {
    if (status.running) return { alreadyRunning: true }
    return spawnDetachedDaemon(home, options) ? { started: true } : {}
  }
  if (!status.running) return {}
  return (await stopDaemon(home)) ? { stopped: true } : {}
}

/** 观测面（doctor / web 状态行）：daemon.lock 持有者是否存活。只读，不加锁。 */
export async function readDaemonStatus(home: string): Promise<{ running: boolean; pid?: number }> {
  let pid = 0
  try {
    const raw = JSON.parse(await readFile(join(home, DAEMON_LOCK_FILENAME), 'utf8')) as {
      pid?: unknown
    }
    if (typeof raw.pid === 'number') pid = raw.pid
  } catch {
    return { running: false }
  }
  if (pid <= 0) return { running: false }
  try {
    process.kill(pid, 0)
    return { running: true, pid }
  } catch (error) {
    // EPERM = 进程存在但不可信号（root 持锁等）→ 视为存活。
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return { running: true, pid }
    return { running: false }
  }
}

/* ── 执行器（可注入端口；测试用 fake runner） ────────────────────────────── */

export interface TaskRunOutcome {
  exitCode: number
  sessionId?: string
  timedOut?: boolean
}

export type TaskRunner = (
  task: TaskDefinition,
  scheduledFor: number,
  runId: string,
) => Promise<TaskRunOutcome>

/* ── 运行终态通知（webhook）───────────────────────────────────────────────── */

/**
 * 运行终态通知载荷：daemon 在 journal 落账后发出。覆盖会话事件够不着的终态
 * （超时 SIGKILL、config drift、trust 丢失、boot 收尸）——session 流里的
 * task.completed / task.failed 只在子进程活着走完回合时才存在。webhook
 * sender 原样 POST 本对象。
 */
export interface TaskRunNotice {
  event: 'task.completed' | 'task.failed'
  taskId: string
  taskName: string
  runId: string
  /** 本次窗口应触发时刻（epoch ms，与 journal / 游标同源）。 */
  scheduledFor: number
  /** 收尾时刻（epoch ms）；drift / trust 拒跑时即拒绝时刻。 */
  finishedAt: number
  startedAt?: number
  durationMs?: number
  exitCode?: number
  error?: { code: string; message: string }
  /** 子会话 id（journal 回填的同一值），接收方可用于跳转 transcript。 */
  sessionId?: string
}

/** 通知端口（可注入，测试用 fake）；实现自抛错由 daemon 捕获告警，不反压调度。 */
export type TaskRunNotifier = (notice: TaskRunNotice) => Promise<void>

export interface WebhookNotifierOptions {
  /** 每次投递时读取（跟随 [tasks] 每 tick 热重载）；空值 = 本投递跳过。 */
  url: () => string | undefined
  timeoutMs?: number
  maxAttempts?: number
  logger?: Pick<Logger, 'warn'>
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export const WEBHOOK_TIMEOUT_MS = 10_000
export const WEBHOOK_MAX_ATTEMPTS = 3

/**
 * 生产通知器：POST JSON，2xx 即成功；4xx（除 408/429）是配置性失败不重试，
 * 其余（网络错误 / 超时 / 5xx / 429）按 0.5s 起步退避重试。重试耗尽只告警
 * ——通知是尽力而为，不影响记账与调度。
 */
export function createWebhookNotifier(options: WebhookNotifierOptions): TaskRunNotifier {
  const fetchFn = options.fetchFn ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS
  const maxAttempts = options.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS
  const warn = (notice: TaskRunNotice, url: string, context: Record<string, JsonValue>): void => {
    options.logger?.warn('task webhook delivery failed', {
      url,
      taskId: notice.taskId,
      runId: notice.runId,
      ...context,
    })
  }
  return async (notice) => {
    const url = options.url()
    if (!url) return
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const last = attempt === maxAttempts
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(notice),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.ok) return
        const status = response.status
        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429
        if (permanent || last) {
          warn(notice, url, { status, attempts: attempt })
          return
        }
      } catch (error) {
        if (last) {
          warn(notice, url, {
            error: error instanceof Error ? error.message : String(error),
            attempts: attempt,
          })
          return
        }
      }
      await sleep(500 * 2 ** (attempt - 1))
    }
  }
}

/**
 * 生产执行器：重执行当前 CLI 二进制（bun compile 产物 argv[1] 是首个 CLI 参数、
 * dev 下是脚本路径，用 existsSync 区分），提交 `"<prompt>" --json`。stdout 按
 * 截尾捕获，sessionId 取自首帧 NDJSON；超时 SIGKILL。
 */
export function createProcessTaskRunner(options?: { execArgv?: string[] }): TaskRunner {
  return (task, scheduledFor, runId) =>
    new Promise<TaskRunOutcome>((resolve, reject) => {
      const timeoutMs = task.constraints?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
      // F1-02 执行面：冻结约束经旗标传入 headless 子进程（budget JSON /
      // allowedTools CSV；model 钉进会话）。timeoutMs 由本进程 SIGKILL 承担。
      const argv = [
        ...(options?.execArgv ?? reexecArgv()),
        ...(task.constraints?.model ? ['--model', task.constraints.model] : []),
        ...(task.constraints?.budget ? ['--budget', JSON.stringify(task.constraints.budget)] : []),
        ...(task.constraints?.allowedTools?.length
          ? ['--allowed-tools', task.constraints.allowedTools.join(',')]
          : []),
        task.prompt,
        '--json',
      ]
      const child = spawn(process.execPath, argv, {
        cwd: task.cwd,
        env: {
          ...process.env,
          // W-17：子会话凭此在自己的事件流发射 task.started/completed/failed。
          VOLUND_TASK_RUN: JSON.stringify({ taskId: task.id, runId, scheduledFor }),
        },
        stdio: ['ignore', 'pipe', 'pipe'] as const,
      })
      const stdout = new OutputTail(CHILD_OUTPUT_TAIL_BYTES)
      const stderr = new OutputTail(64 * 1024)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', () => {
        clearTimeout(timer)
        const exitCode = timedOut ? -1 : (child.exitCode ?? -1)
        const sessionId = sessionIdFromNdjson(stdout.text())
        resolve({
          exitCode,
          ...(sessionId ? { sessionId } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        })
      })
    })
}

/** dev（argv[1]=脚本路径）与 bun compile 产物（argv[1]=首个 CLI 参数）的重执行参数。 */
function reexecArgv(): string[] {
  const first = process.argv[1] ?? ''
  return first && !first.startsWith('-') && existsSync(first) ? [first] : []
}

class OutputTail {
  #buffers: Buffer[] = []
  #bytes = 0
  constructor(readonly limit: number) {}
  push(chunk: Buffer): void {
    this.#buffers.push(chunk)
    this.#bytes += chunk.length
    while (this.#bytes > this.limit && this.#buffers.length > 1) {
      const dropped = this.#buffers.shift()
      this.#bytes -= dropped?.length ?? 0
    }
  }
  text(): string {
    return Buffer.concat(this.#buffers).toString('utf8')
  }
}

function sessionIdFromNdjson(text: string): string | undefined {
  let inspected = 0
  for (const line of text.split('\n')) {
    if (inspected++ >= 200) return undefined
    if (!line.startsWith('{')) continue
    try {
      const value = JSON.parse(line) as { sessionId?: unknown }
      if (typeof value.sessionId === 'string' && value.sessionId !== '') return value.sessionId
    } catch {
      // 半行/非 JSON 行：NDJSON 流里正常，跳过。
    }
  }
  return undefined
}

/* ── 单实例锁（进程生命周期级，比 store 事务锁简单：一次获取 + 死进程回收） ── */

async function acquireDaemonLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const lockPath = join(home, DAEMON_LOCK_FILENAME)
  for (;;) {
    try {
      const file = await open(lockPath, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
        await file.sync()
      } finally {
        await file.close()
      }
      return async () => {
        await rm(lockPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid = 0
      try {
        const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }
        if (typeof raw.pid === 'number') ownerPid = raw.pid
      } catch {
        // 无法解析的锁文件按死进程处理（回收重来）。
      }
      let alive = true
      if (ownerPid > 0) {
        try {
          process.kill(ownerPid, 0)
        } catch (killError) {
          alive = (killError as NodeJS.ErrnoException).code === 'EPERM'
        }
      }
      if (alive && ownerPid !== process.pid) {
        throw new VolundError(
          'task_daemon_running',
          `another volund daemon (pid ${ownerPid || 'unknown'}) owns the task scheduler`,
        )
      }
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }
}

/* ── daemon 宿主 ─────────────────────────────────────────────────────────── */

export interface TaskDaemonOptions {
  store: TaskStore
  home: string
  sections: TaskDaemonSections
  trust: { check(path: string): Promise<{ trusted: boolean }> }
  runner: TaskRunner
  /** 运行终态通知（journal 落账后调用）；缺省不发。 */
  notifier?: TaskRunNotifier
  configHash: () => Promise<string>
  now?: () => number
  /** 缺省 15s（任务粒度下限 60s，tick 只负责及时性，不承担精度语义）。 */
  tickIntervalMs?: number
  logger?: Pick<Logger, 'info' | 'warn'>
  /**
   * 每 tick 重读 [tasks] 段（开关热语义：enabled 翻 false → 释放锁自退出；
   * max_concurrent 热生效）。缺省不重读（测试/嵌入式宿主用）。
   */
  reloadSections?: () => Promise<TaskDaemonSections>
  /** 开关热关闭触发（独占一次；宿主在此决定退出进程）。 */
  onDisabled?: () => void
}

export interface TickOutcome {
  fired: number
  missed: number
  skipped: number
  deferred: number
  /** 开关热关闭：锁已释放、tick 已停（宿主应退出）。 */
  stopped?: 'disabled'
}

export class TaskDaemon {
  readonly bootAt: number
  readonly #store: TaskStore
  readonly #options: TaskDaemonOptions
  readonly #inFlight = new Map<string, { runId: string; scheduledFor: number }>()
  #timer: ReturnType<typeof setInterval> | undefined
  #releaseLock: (() => Promise<void>) | undefined
  #sections: TaskDaemonSections
  #disabledNotified = false

  constructor(options: TaskDaemonOptions) {
    this.#options = options
    this.bootAt = options.now?.() ?? Date.now()
    this.#store = options.store
    this.#sections = options.sections
  }

  private get sections(): TaskDaemonSections {
    return this.#sections
  }

  /** 单实例锁 + 在途记录收尸（前一 daemon 死亡时的 'running' 改判 failed）。 */
  async boot(): Promise<{ recovered: number }> {
    this.#releaseLock = await acquireDaemonLock(this.#options.home)
    const snapshot = await this.#store.loadSnapshot()
    let recovered = 0
    for (const run of snapshot.runs) {
      if (run.status !== 'running') continue
      const error = {
        code: 'task_run_failed',
        message: 'daemon exited while the run was in flight',
      }
      await this.#store.updateRun(run.runId, {
        status: 'failed',
        finishedAt: this.bootAt,
        error,
      })
      const task = snapshot.tasks.find((candidate) => candidate.id === run.taskId)
      await this.#notifyRunFinished(task, {
        event: 'task.failed',
        taskId: run.taskId,
        taskName: task?.name ?? run.taskId,
        runId: run.runId,
        scheduledFor: run.scheduledFor,
        finishedAt: this.bootAt,
        error,
      })
      recovered++
    }
    return { recovered }
  }

  start(): void {
    if (this.#timer) return
    const interval = this.#options.tickIntervalMs ?? 15_000
    // 有意不 unref：daemon 前台进程靠这个句柄活着；SIGINT/SIGTERM 走 bin.ts 收尾。
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.#options.logger?.warn('task daemon tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, interval)
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    await this.#releaseLock?.()
    this.#releaseLock = undefined
  }

  /** 当前在途运行数（观测面；测试断言用）。 */
  get inFlightCount(): number {
    return this.#inFlight.size
  }

  async tick(): Promise<TickOutcome> {
    const now = this.#options.now?.() ?? Date.now()
    if (this.#options.reloadSections) {
      this.#sections = await this.#options.reloadSections()
      if (!this.#sections.enabled) {
        await this.stop()
        if (!this.#disabledNotified) {
          this.#disabledNotified = true
          this.#options.onDisabled?.()
        }
        return { fired: 0, missed: 0, skipped: 0, deferred: 0, stopped: 'disabled' }
      }
    }
    const snapshot = await this.#store.loadSnapshot()
    const outcome = evaluateTick({
      now,
      bootAt: this.bootAt,
      tasks: snapshot.tasks,
      cursors: snapshot.cursors,
      runningTaskIds: new Set(this.#inFlight.keys()),
    })

    const tickOutcome: TickOutcome = { fired: 0, missed: 0, skipped: 0, deferred: 0 }
    for (const entry of outcome.missed) {
      if (entry.fires) continue // run_latest 的补跑走 fires 管线，journal 由 'running' 记录承担。
      await this.#store.recordRun({
        runId: randomUUID(),
        taskId: entry.task.id,
        status: 'missed',
        scheduledFor: entry.scheduledFor,
      })
      tickOutcome.missed += entry.count
    }
    for (const skip of outcome.skipped) {
      await this.#store.recordRun({
        runId: randomUUID(),
        taskId: skip.task.id,
        status: 'skipped',
        scheduledFor: skip.scheduledFor,
      })
      tickOutcome.skipped++
    }

    // capacity 门（F1-04 overlap/资源上限）：满了整批延到下一 tick，不记账
    // （游标不推进，窗口自然重估）。fire 分支里同任务只 spawn 最新窗口。
    const firesByTask = new Map<string, TaskFire[]>()
    for (const fire of outcome.fires) {
      if (fire.queued) {
        tickOutcome.deferred++
        continue
      }
      const group = firesByTask.get(fire.task.id)
      if (group) group.push(fire)
      else firesByTask.set(fire.task.id, [fire])
    }
    for (const group of firesByTask.values()) {
      const latest = group[group.length - 1]
      if (!latest) continue
      if (this.#inFlight.size >= this.#sections.maxConcurrent) {
        tickOutcome.deferred += group.length
        continue
      }
      for (const stale of group.slice(0, group.length - MAX_FIRES_PER_TASK_PER_TICK)) {
        await this.#store.recordRun({
          runId: randomUUID(),
          taskId: stale.task.id,
          status: 'missed',
          scheduledFor: stale.scheduledFor,
        })
        tickOutcome.missed++
      }
      if (await this.#launch(latest.task, latest.scheduledFor)) tickOutcome.fired++
    }
    return tickOutcome
  }

  /**
   * 终态通知（尽力而为）：通知器抛错只告警——通知失败不影响记账与调度。
   * task 缺省（boot 收尸时任务已被删除）也发，taskName 退化为 id。
   */
  async #notifyRunFinished(task: TaskDefinition | undefined, notice: TaskRunNotice): Promise<void> {
    const notifier = this.#options.notifier
    if (!notifier) return
    try {
      await notifier(notice)
    } catch (error) {
      this.#options.logger?.warn('task run notifier failed', {
        taskId: notice.taskId,
        runId: notice.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 拒跑（config drift / trust 丢失）：journal 记 failed + 通知，未 spawn。 */
  async #rejectLaunch(
    task: TaskDefinition,
    scheduledFor: number,
    error: { code: string; message: string },
  ): Promise<false> {
    const runId = randomUUID()
    await this.#store.recordRun({
      runId,
      taskId: task.id,
      status: 'failed',
      scheduledFor,
      error,
    })
    await this.#notifyRunFinished(task, {
      event: 'task.failed',
      taskId: task.id,
      taskName: task.name,
      runId,
      scheduledFor,
      finishedAt: this.#options.now?.() ?? Date.now(),
      error,
    })
    return false
  }

  /**
   * 前置重验（F1-03）→ 记 'running' → spawn（不等待完成，完成回调异步落账）。
   * 返回 false = 前置重验拒绝（journal 记 failed），未 spawn。
   */
  async #launch(task: TaskDefinition, scheduledFor: number): Promise<boolean> {
    if (task.configHash) {
      const current = await this.#options.configHash()
      if (current !== task.configHash) {
        return this.#rejectLaunch(task, scheduledFor, {
          code: 'task_config_drift',
          message:
            'config.toml changed since the task was created; re-create the task to re-freeze',
        })
      }
    }
    const trust = await this.#options.trust.check(task.cwd).catch(() => ({ trusted: false }))
    if (!trust.trusted) {
      return this.#rejectLaunch(task, scheduledFor, {
        code: 'task_trust_missing',
        message: `directory is no longer trusted: ${task.cwd}`,
      })
    }

    const runId = randomUUID()
    const startedAt = this.#options.now?.() ?? Date.now()
    await this.#store.recordRun({
      runId,
      taskId: task.id,
      status: 'running',
      scheduledFor,
      startedAt,
    })
    this.#inFlight.set(task.id, { runId, scheduledFor })
    void (async () => {
      try {
        const outcome = await this.#options.runner(task, scheduledFor, runId)
        const finishedAt = this.#options.now?.() ?? Date.now()
        const completed = outcome.exitCode === 0
        const failure = completed
          ? undefined
          : {
              code: 'task_run_failed',
              message: outcome.timedOut
                ? `run timed out after ${task.constraints?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms and was killed`
                : `run exited with code ${outcome.exitCode}`,
            }
        await this.#store.updateRun(
          runId,
          completed
            ? {
                status: 'completed',
                finishedAt,
                exitCode: 0,
                ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
              }
            : {
                status: 'failed',
                finishedAt,
                exitCode: outcome.exitCode,
                ...(failure ? { error: failure } : {}),
              },
        )
        await this.#notifyRunFinished(task, {
          event: completed ? 'task.completed' : 'task.failed',
          taskId: task.id,
          taskName: task.name,
          runId,
          scheduledFor,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
          ...(completed ? {} : { exitCode: outcome.exitCode }),
          ...(failure ? { error: failure } : {}),
          ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        })
      } catch (error) {
        const finishedAt = this.#options.now?.() ?? Date.now()
        const failure = {
          code: 'task_run_failed',
          message: `runner failed: ${error instanceof Error ? error.message : String(error)}`,
        }
        await this.#store
          .updateRun(runId, { status: 'failed', finishedAt, error: failure })
          .catch(() => undefined)
        await this.#notifyRunFinished(task, {
          event: 'task.failed',
          taskId: task.id,
          taskName: task.name,
          runId,
          scheduledFor,
          startedAt,
          finishedAt,
          error: failure,
        })
      } finally {
        this.#inFlight.delete(task.id)
      }
    })()
    return true
  }
}

/** 任务存储的约定落点（命令族与 daemon 共用）。 */
export function taskStorePath(home: string): string {
  return join(home, 'tasks.json')
}
