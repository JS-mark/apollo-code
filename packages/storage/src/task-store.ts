/**
 * TaskStore — 定时任务定义与运行 journal 的持久化（W-17 / Web 计划 F1-04）。
 *
 * 单文件快照（`<volundHome>/tasks.json`），锁 + 原子写 + .bak 恢复的纪律与
 * LocalMemoryRepository（memory-runtime.ts）同款——批量复制而非抽象共享是该
 * 文件尚无第二消费方的务实决定；第三处需要时再抽通用 file-lock 工具。
 *
 * 每任务的调度游标 `cursors[taskId]` = 该任务最近一次应触发时刻（epoch ms），
 * 随运行记录一并落盘：journal 受 retention 截断（F1-04 log retention），
 * 调度游标不受其影响（否则 daemon 长时间停机后会把 createdAt 以来全部视为
 * 错过窗口）。运行记录只做观测面，调度判定用 cursors。
 */
import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

import { validateTaskDefinition, VolundError, type TaskDefinition } from '@volund/shared'

export const TASK_STORE_SCHEMA_VERSION = 'volund.tasks.v1'

export type TaskRunStatus = 'missed' | 'skipped' | 'running' | 'completed' | 'failed'

export interface TaskRunRecord {
  readonly runId: string
  readonly taskId: string
  readonly status: TaskRunStatus
  /** 本次窗口应触发的时刻（epoch ms）——补跑/去重/游标都锚在它上面。 */
  readonly scheduledFor: number
  readonly startedAt?: number
  readonly finishedAt?: number
  /** 对应 headless 会话档案 id（daemon spawn 后回填）。 */
  readonly sessionId?: string
  readonly exitCode?: number
  /** 报错形态沿用 `{code, message}`（英文 detail + 登记码）。 */
  readonly error?: { readonly code: string; readonly message: string }
}

export type TaskRunPatch = Partial<
  Pick<TaskRunRecord, 'status' | 'startedAt' | 'finishedAt' | 'sessionId' | 'exitCode' | 'error'>
>

export interface TaskSnapshot {
  readonly schemaVersion: typeof TASK_STORE_SCHEMA_VERSION
  readonly tasks: readonly TaskDefinition[]
  readonly runs: readonly TaskRunRecord[]
  /** 每任务最近一次应触发时刻（epoch ms）；调度游标，与 retention 无关。 */
  readonly cursors: Readonly<Record<string, number>>
}

export type TaskErrorCode = 'task_definition_invalid' | 'task_io' | 'task_store_corrupt'

export class TaskError extends VolundError {
  constructor(
    override readonly code: TaskErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, undefined, options)
    this.name = 'TaskError'
  }
}

export interface TaskStoreOptions {
  /** 上限同时约束写者与一致性读者的等锁时间（测试可调大以制造竞争）。 */
  lockTimeoutMs?: number
  lockRetryMs?: number
  /** journal 保留条数（F1-04 log retention），默认 200。 */
  journalRetention?: number
}

const DEFAULT_JOURNAL_RETENTION = 200

export class TaskStore {
  readonly #lockPath: string
  readonly #journalRetention: number

  constructor(
    readonly path: string,
    readonly options: TaskStoreOptions = {},
  ) {
    this.#lockPath = `${path}.lock`
    this.#journalRetention = options.journalRetention ?? DEFAULT_JOURNAL_RETENTION
  }

  async listTasks(): Promise<readonly TaskDefinition[]> {
    const release = await this.#acquireLock()
    try {
      return (await this.#loadUnlocked()).tasks
    } finally {
      await release()
    }
  }

  async getTask(id: string): Promise<TaskDefinition | undefined> {
    const release = await this.#acquireLock()
    try {
      return (await this.#loadUnlocked()).tasks.find((task) => task.id === id)
    } finally {
      await release()
    }
  }

  /** 校验并 upsert（按 id）；校验失败抛 task_definition_invalid，issue 列表进 details。 */
  async upsertTask(definition: unknown): Promise<TaskDefinition> {
    const validated = validateTaskDefinition(definition)
    if (!validated.ok) {
      throw new TaskError('task_definition_invalid', 'Task definition failed validation', {
        cause: validated.issues,
      })
    }
    const task = validated.value
    const release = await this.#acquireLock()
    try {
      const snapshot = await this.#loadUnlocked()
      const tasks = snapshot.tasks.some((existing) => existing.id === task.id)
        ? snapshot.tasks.map((existing) => (existing.id === task.id ? task : existing))
        : [...snapshot.tasks, task]
      await this.#saveUnlocked({ ...snapshot, tasks })
      return task
    } finally {
      await release()
    }
  }

  async removeTask(id: string): Promise<boolean> {
    const release = await this.#acquireLock()
    try {
      const snapshot = await this.#loadUnlocked()
      if (!snapshot.tasks.some((task) => task.id === id)) return false
      const { [id]: _removed, ...cursors } = snapshot.cursors
      await this.#saveUnlocked({
        ...snapshot,
        tasks: snapshot.tasks.filter((task) => task.id !== id),
        cursors,
      })
      return true
    } finally {
      await release()
    }
  }

  /** 追加运行记录并截断 retention；同任务游标推进到 max(现值, scheduledFor)。 */
  async recordRun(record: TaskRunRecord): Promise<void> {
    const release = await this.#acquireLock()
    try {
      const snapshot = await this.#loadUnlocked()
      const runs = [...snapshot.runs, record].slice(-this.#journalRetention)
      const previous = snapshot.cursors[record.taskId] ?? 0
      await this.#saveUnlocked({
        ...snapshot,
        runs,
        cursors: {
          ...snapshot.cursors,
          [record.taskId]: Math.max(previous, record.scheduledFor),
        },
      })
    } finally {
      await release()
    }
  }

  async updateRun(runId: string, patch: TaskRunPatch): Promise<TaskRunRecord | undefined> {
    const release = await this.#acquireLock()
    try {
      const snapshot = await this.#loadUnlocked()
      const runs = snapshot.runs.map((run) => (run.runId === runId ? mergeRun(run, patch) : run))
      const updated = runs.find((run) => run.runId === runId)
      if (!updated) return undefined
      await this.#saveUnlocked({ ...snapshot, runs })
      return updated
    } finally {
      await release()
    }
  }

  /** 运行记录（新→旧）；taskId 过滤 + limit 截断。 */
  async recentRuns(options?: {
    taskId?: string
    limit?: number
  }): Promise<readonly TaskRunRecord[]> {
    const release = await this.#acquireLock()
    try {
      const snapshot = await this.#loadUnlocked()
      const filtered = options?.taskId
        ? snapshot.runs.filter((run) => run.taskId === options.taskId)
        : snapshot.runs
      return [...filtered].reverse().slice(0, options?.limit ?? 50)
    } finally {
      await release()
    }
  }

  async loadSnapshot(): Promise<TaskSnapshot> {
    const release = await this.#acquireLock()
    try {
      return await this.#loadUnlocked()
    } finally {
      await release()
    }
  }

  async #loadUnlocked(): Promise<TaskSnapshot> {
    const primary = await this.#read(this.path)
    if (primary.ok) return primary.snapshot
    const backup = await this.#read(`${this.path}.bak`)
    if (backup.ok) return backup.snapshot
    if (primary.missing && backup.missing) {
      return { schemaVersion: TASK_STORE_SCHEMA_VERSION, tasks: [], runs: [], cursors: {} }
    }
    throw new TaskError(
      'task_store_corrupt',
      'Task store snapshot and recovery backup are unreadable',
      {
        cause: primary.error ?? backup.error,
      },
    )
  }

  async #read(
    path: string,
  ): Promise<
    { ok: true; snapshot: TaskSnapshot } | { ok: false; missing: boolean; error: unknown }
  > {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      return { ok: true, snapshot: parseSnapshot(raw) }
    } catch (error) {
      return { ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', error }
    }
  }

  async #saveUnlocked(snapshot: TaskSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(snapshot))
      await file.sync()
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await file.close()
    try {
      await rm(`${this.path}.bak`, { force: true })
      await rename(this.path, `${this.path}.bak`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await rename(temporary, this.path)
      // Windows does not support fsync on directory handles and returns EPERM.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      await rename(`${this.path}.bak`, this.path).catch(() => undefined)
      throw error
    }
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const timeoutMs = this.options.lockTimeoutMs ?? 10_000
    const retryMs = this.options.lockRetryMs ?? 10
    const deadline = Date.now() + timeoutMs

    for (;;) {
      try {
        const file = await open(this.#lockPath, 'wx', 0o600)
        try {
          await file.writeFile(
            JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }),
          )
          await file.sync()
        } catch (error) {
          await file.close().catch(() => undefined)
          await rm(this.#lockPath, { force: true }).catch(() => undefined)
          throw error
        }
        await file.close()
        return async () => {
          try {
            const owner = JSON.parse(await readFile(this.#lockPath, 'utf8')) as {
              token?: unknown
            }
            if (owner.token !== token) return
            await rm(this.#lockPath, { force: true }).catch(
              (removeError: NodeJS.ErrnoException) => {
                if (!isTransientLockErrorCode(removeError.code)) throw removeError
              },
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!isTransientLockErrorCode(code)) throw error
        if (code === 'EEXIST' && !(await lockOwnerAlive(this.#lockPath))) {
          await rm(this.#lockPath, { force: true }).catch((removeError: NodeJS.ErrnoException) => {
            if (!isTransientLockErrorCode(removeError.code)) throw removeError
          })
          continue
        }
        if (Date.now() >= deadline)
          throw new TaskError('task_io', 'Timed out waiting for the task store lock', {
            cause: error,
          })
        await delay(retryMs)
      }
    }
  }
}

/** exactOptionalPropertyTypes：patch 字段按存在性条件合并，undefined 不落盘。 */
function mergeRun(run: TaskRunRecord, patch: TaskRunPatch): TaskRunRecord {
  return {
    ...run,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  }
}

function parseSnapshot(raw: unknown): TaskSnapshot {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== TASK_STORE_SCHEMA_VERSION
  ) {
    throw new TaskError('task_store_corrupt', 'Unknown task store schema version')
  }
  const value = raw as Record<string, unknown>
  const tasks: TaskDefinition[] = []
  for (const entry of Array.isArray(value.tasks) ? value.tasks : []) {
    const validated = validateTaskDefinition(entry)
    if (!validated.ok) {
      throw new TaskError('task_store_corrupt', 'Task store holds an invalid task definition', {
        cause: validated.issues,
      })
    }
    tasks.push(validated.value)
  }
  if (!Array.isArray(value.runs)) {
    throw new TaskError('task_store_corrupt', 'Task store runs journal is not an array')
  }
  const runs: TaskRunRecord[] = []
  for (const entry of value.runs) {
    if (!entry || typeof entry !== 'object') {
      throw new TaskError('task_store_corrupt', 'Task store holds a malformed run record')
    }
    const run = entry as Record<string, unknown>
    if (
      typeof run.runId !== 'string' ||
      typeof run.taskId !== 'string' ||
      typeof run.status !== 'string' ||
      typeof run.scheduledFor !== 'number'
    ) {
      throw new TaskError('task_store_corrupt', 'Task store holds a malformed run record')
    }
    runs.push(run as unknown as TaskRunRecord)
  }
  const cursors: Record<string, number> = {}
  for (const [taskId, at] of Object.entries(value.cursors ?? {})) {
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new TaskError('task_store_corrupt', `Task store cursor for '${taskId}' is not a number`)
    }
    cursors[taskId] = at
  }
  return { schemaVersion: TASK_STORE_SCHEMA_VERSION, tasks, runs, cursors }
}

/**
 * Lock error codes that mean "contended right now", not "broken"（Windows
 * delete-pending / sharing violation / 杀软扫描；同 memory-runtime LL-7）。
 */
function isTransientLockErrorCode(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
      // A competing process can observe the file between exclusive creation and
      // metadata fsync. Give that live acquisition a short grace period.
      return Date.now() - (await stat(path)).mtimeMs < 1_000
    }
    try {
      process.kill(Number(value.pid), 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch {
    return false
  }
}
