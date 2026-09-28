import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { VolundError, type TaskDefinition } from '@volund/shared'
import { TaskStore } from '@volund/storage'
import { afterEach, describe, expect, it } from 'vitest'

import {
  computeConfigHash,
  createProcessTaskRunner,
  createWebhookNotifier,
  readDaemonStatus,
  stopDaemon,
  syncDaemonWithSwitch,
  TaskDaemon,
  taskSectionsFromConfig,
  type TaskDaemonOptions,
  type TaskRunNotice,
  type TaskRunNotifier,
  type TaskRunOutcome,
  type TaskRunner,
} from './daemon'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-daemon-'))
  directories.push(dir)
  return dir
}

const T0 = 1_770_000_000_000
const MINUTE = 60_000

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'job',
    name: 'Job',
    enabled: true,
    prompt: 'say hi',
    cwd: '/trusted/repo',
    schedule: { kind: 'interval', everyMs: MINUTE },
    missedRun: 'skip',
    overlap: 'skip',
    createdAt: T0,
    ...overrides,
  }
}

interface HarnessOptions {
  maxConcurrent?: number
  runner?: TaskRunner
  trusted?: boolean
  configHash?: string
  now?: () => number
  notifier?: TaskRunNotifier
}

async function harness(options: HarnessOptions = {}) {
  const home = await tempHome()
  const store = new TaskStore(join(home, 'tasks.json'))
  const daemonOptions: TaskDaemonOptions = {
    store,
    home,
    sections: { enabled: true, maxConcurrent: options.maxConcurrent ?? 1, journalRetention: 200 },
    trust: { check: async () => ({ trusted: options.trusted ?? true }) },
    runner:
      options.runner ??
      (async (): Promise<TaskRunOutcome> => ({ exitCode: 0, sessionId: 'sess_child' })),
    configHash: async () => options.configHash ?? 'hash-current',
    ...(options.now ? { now: options.now } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
  }
  const daemon = new TaskDaemon(daemonOptions)
  return { home, store, daemon, options: daemonOptions }
}

/** 完成回调是 void 异步：让出微任务+宏任务两轮后再读 journal。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 终态通知落在内存数组、断言前没有 IO 让出事件循环——journal 断言自带的
 * 读盘时延这里没有，须轮询等待（updateRun 落账 + 通知都要真实的 IO 轮次）。
 */
async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeDaemon(store: TaskStore, home: string, overrides: Partial<TaskDaemonOptions> = {}) {
  return new TaskDaemon({
    store,
    home,
    sections: { enabled: true, maxConcurrent: 1, journalRetention: 200 },
    trust: { check: async () => ({ trusted: true }) },
    runner: async () => ({ exitCode: 0, sessionId: 'sess_child' }),
    configHash: async () => 'hash-current',
    ...overrides,
  })
}

describe('TaskDaemon boot', () => {
  it('is single-instance: a live foreign lock fails with task_daemon_running', async () => {
    const home = await tempHome()
    const store = new TaskStore(join(home, 'tasks.json'))
    const first = makeDaemon(store, home)
    await first.boot()
    await first.stop()

    // pid 1 恒存活（root 下 kill 成功、非 root EPERM——两分支都判「存活」）。
    await writeFile(
      join(home, 'daemon.lock'),
      JSON.stringify({ pid: 1, at: new Date().toISOString() }),
    )
    await expect(makeDaemon(store, home).boot()).rejects.toMatchObject({
      name: 'VolundError',
      code: 'task_daemon_running',
    })
  })

  it('reclaims its own lock after stop', async () => {
    const { daemon } = await harness()
    await daemon.boot()
    await daemon.stop()
    await expect(daemon.boot()).resolves.toMatchObject({ recovered: 0 })
  })

  it('marks journal entries left running by a dead daemon as failed', async () => {
    const home = await tempHome()
    const store = new TaskStore(join(home, 'tasks.json'))
    await store.upsertTask(definition())
    await store.recordRun({
      runId: 'orphan',
      taskId: 'job',
      status: 'running',
      scheduledFor: T0 - MINUTE,
    })
    const daemon = makeDaemon(store, home, { now: () => T0 })
    await expect(daemon.boot()).resolves.toEqual({ recovered: 1 })
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({
      runId: 'orphan',
      status: 'failed',
      error: { code: 'task_run_failed' },
    })
  })
})

describe('TaskDaemon tick', () => {
  it('spawns the latest due window and books earlier ones as missed', async () => {
    let now = T0
    const { store, daemon } = await harness({ now: () => now })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + 2 * MINUTE + 1_000
    const outcome = await daemon.tick()
    expect(outcome.fired).toBe(1)
    expect(outcome.missed).toBe(1)
    await settle()
    await settle()
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs.map((run) => run.status)).toEqual(['completed', 'missed'])
    expect(runs[0]).toMatchObject({ exitCode: 0, sessionId: 'sess_child' })
    expect(runs[0]?.finishedAt).toBeTypeOf('number')
    const snapshot = await store.loadSnapshot()
    expect(snapshot.cursors['job']).toBe(T0 + 2 * MINUTE)
    expect(daemon.inFlightCount).toBe(0)
  })

  it('refuses to run when config hash drifted (F1-03)', async () => {
    let now = T0
    const { store, daemon } = await harness({
      now: () => now,
      configHash: 'hash-rotated',
    })
    await store.upsertTask(definition({ configHash: 'hash-frozen' }))
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(0)
    await settle()
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({ status: 'failed', error: { code: 'task_config_drift' } })
  })

  it('refuses to run when the frozen cwd lost trust (F1-03)', async () => {
    let now = T0
    const { store, daemon } = await harness({
      now: () => now,
      trusted: false,
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    await daemon.tick()
    await settle()
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({ status: 'failed', error: { code: 'task_trust_missing' } })
  })

  it('defers fires beyond max_concurrent and retries next tick', async () => {
    let now = T0
    let releaseA: (() => void) | undefined
    const { store, daemon } = await harness({
      now: () => now,
      maxConcurrent: 1,
      runner: (task) =>
        new Promise<TaskRunOutcome>((resolve) => {
          if (task.id === 'a') releaseA = () => resolve({ exitCode: 0 })
          else resolve({ exitCode: 0 })
        }),
    })
    await store.upsertTask(definition({ id: 'a', name: 'A' }))
    await store.upsertTask(definition({ id: 'b', name: 'B' }))
    await daemon.boot()
    now = T0 + MINUTE + 1_000

    await expect(daemon.tick()).resolves.toMatchObject({ fired: 1, deferred: 1 })
    expect(daemon.inFlightCount).toBe(1)

    releaseA?.()
    await settle()
    await expect(daemon.tick()).resolves.toMatchObject({ fired: 1, deferred: 0 })
  })

  it('books overlap=skip windows as skipped while a run is in flight', async () => {
    let now = T0
    const { store, daemon } = await harness({
      now: () => now,
      runner: () => new Promise<TaskRunOutcome>(() => undefined), // 永在途
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(1)
    now = T0 + 2 * MINUTE + 1_000
    expect((await daemon.tick()).skipped).toBe(1)
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({ status: 'skipped' })
  })

  it('queues overlap=queue windows behind the in-flight run', async () => {
    let now = T0
    const { store, daemon } = await harness({
      now: () => now,
      runner: () => new Promise<TaskRunOutcome>(() => undefined),
    })
    await store.upsertTask(definition({ overlap: 'queue' }))
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    expect(await daemon.tick()).toMatchObject({ fired: 1 })
    now = T0 + 2 * MINUTE + 1_000
    // 在途 + queue：窗口延迟重估（deferred），不记账不丢窗。
    expect(await daemon.tick()).toMatchObject({ fired: 0, deferred: 1, skipped: 0 })
    expect((await store.recentRuns({ taskId: 'job' })).map((run) => run.status)).toEqual([
      'running',
    ])
  })

  it('catches up missed windows under run_latest after a late boot', async () => {
    const home = await tempHome()
    const store = new TaskStore(join(home, 'tasks.json'))
    await store.upsertTask(definition({ missedRun: 'run_latest' }))
    // createdAt=T0，daemon 在 T0+10min 才首次 boot：60s..540s 九个错过窗口，
    // 600s 窗口恰好落在 boot 时刻 → 归入 due。
    const daemon = makeDaemon(store, home, { now: () => T0 + 10 * MINUTE })
    await daemon.boot()
    expect((await daemon.tick()).fired).toBe(1)
    await settle()
    await settle()
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({ status: 'completed', scheduledFor: T0 + 10 * MINUTE })
    expect(runs.some((run) => run.status === 'missed')).toBe(true)
  })
})

describe('run-finish notifications', () => {
  it('notifies the fire completion but not missed bookkeeping', async () => {
    let now = T0
    const notices: TaskRunNotice[] = []
    const { store, daemon } = await harness({
      now: () => now,
      notifier: async (notice) => {
        notices.push(notice)
      },
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + 2 * MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(1)
    await until(() => notices.length > 0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'task.completed',
      taskId: 'job',
      taskName: 'Job',
      scheduledFor: T0 + 2 * MINUTE,
      sessionId: 'sess_child',
      durationMs: 0,
    })
    expect(notices[0]?.exitCode).toBeUndefined()
  })

  it('notifies failed runs with exit code and error code', async () => {
    let now = T0
    const notices: TaskRunNotice[] = []
    const { store, daemon } = await harness({
      now: () => now,
      notifier: async (notice) => {
        notices.push(notice)
      },
      runner: async (): Promise<TaskRunOutcome> => ({ exitCode: 3 }),
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    await daemon.tick()
    await until(() => notices.length > 0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'task.failed',
      taskId: 'job',
      exitCode: 3,
      error: { code: 'task_run_failed', message: 'run exited with code 3' },
    })
    expect(notices[0]?.sessionId).toBeUndefined()
  })

  it('notifies config drift rejections without run timestamps', async () => {
    let now = T0
    const notices: TaskRunNotice[] = []
    const { store, daemon } = await harness({
      now: () => now,
      configHash: 'hash-rotated',
      notifier: async (notice) => {
        notices.push(notice)
      },
    })
    await store.upsertTask(definition({ configHash: 'hash-frozen' }))
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(0)
    await until(() => notices.length > 0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'task.failed',
      taskId: 'job',
      error: { code: 'task_config_drift' },
    })
    expect(notices[0]?.startedAt).toBeUndefined()
    expect(notices[0]?.durationMs).toBeUndefined()
    expect(notices[0]?.sessionId).toBeUndefined()
  })

  it('notifies trust rejections', async () => {
    let now = T0
    const notices: TaskRunNotice[] = []
    const { store, daemon } = await harness({
      now: () => now,
      trusted: false,
      notifier: async (notice) => {
        notices.push(notice)
      },
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    await daemon.tick()
    await until(() => notices.length > 0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'task.failed',
      error: { code: 'task_trust_missing' },
    })
  })

  it('does not notify for overlap-skipped windows', async () => {
    let now = T0
    const notices: TaskRunNotice[] = []
    const { store, daemon } = await harness({
      now: () => now,
      notifier: async (notice) => {
        notices.push(notice)
      },
      runner: () => new Promise<TaskRunOutcome>(() => undefined), // 永在途
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(1)
    now = T0 + 2 * MINUTE + 1_000
    expect((await daemon.tick()).skipped).toBe(1)
    expect(notices).toEqual([])
  })

  it('notifies recovered in-flight runs as failed on boot', async () => {
    const home = await tempHome()
    const store = new TaskStore(join(home, 'tasks.json'))
    await store.upsertTask(definition())
    await store.recordRun({
      runId: 'orphan',
      taskId: 'job',
      status: 'running',
      scheduledFor: T0 - MINUTE,
    })
    const notices: TaskRunNotice[] = []
    const daemon = makeDaemon(store, home, {
      now: () => T0,
      notifier: async (notice) => {
        notices.push(notice)
      },
    })
    await daemon.boot()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'task.failed',
      taskId: 'job',
      taskName: 'Job',
      runId: 'orphan',
      error: { code: 'task_run_failed' },
    })
  })

  it('keeps journal bookkeeping when the notifier throws', async () => {
    let now = T0
    const { store, daemon } = await harness({
      now: () => now,
      notifier: async () => {
        throw new Error('webhook down')
      },
    })
    await store.upsertTask(definition())
    await daemon.boot()
    now = T0 + MINUTE + 1_000
    await expect(daemon.tick()).resolves.toMatchObject({ fired: 1 })
    await settle()
    await settle()
    const runs = await store.recentRuns({ taskId: 'job' })
    expect(runs[0]).toMatchObject({ status: 'completed', exitCode: 0 })
  })
})

describe('switch-driven lifecycle (r1.4)', () => {
  it('hot-disables on reloadSections.enabled=false: lock released, no fire', async () => {
    let sections = { enabled: true, maxConcurrent: 1, journalRetention: 200 }
    let now = T0
    let notified = false
    const home = await tempHome()
    const store = new TaskStore(join(home, 'tasks.json'))
    await store.upsertTask(definition())
    const daemon = makeDaemon(store, home, {
      now: () => now,
      reloadSections: async () => sections,
      onDisabled: () => {
        notified = true
      },
    })
    await daemon.boot()
    // 第一 tick 正常触发；翻开关后同一 daemon（持锁者）下一 tick 释放锁停摆。
    now = T0 + MINUTE + 1_000
    expect((await daemon.tick()).fired).toBe(1)
    now = T0 + 2 * MINUTE + 1_000
    sections = { enabled: false, maxConcurrent: 1, journalRetention: 200 }
    expect((await daemon.tick()).stopped).toBe('disabled')
    expect(notified).toBe(true)
    expect((await readDaemonStatus(home)).running).toBe(false)
  })

  it('stopDaemon reports false without a live lock', async () => {
    const home = await tempHome()
    expect(await stopDaemon(home)).toBe(false)
  })

  it('spawns a real detached daemon via the switch and stops it again', async () => {
    const entry = resolve(__dirname, '../dist/volund.js')
    if (!existsSync(entry)) return // dist 未构建的环境跳过（l1 e2e 覆盖同路径）
    const home = await tempHome()
    await writeFile(join(home, 'config.toml'), '[tasks]\nenabled = true\n')
    // daemon 进程 cwd 必须过 workspace 守卫（拒根目录/$HOME/~/.volund//private·tmp
    // 整棵）——放 $HOME 子目录（l1 e2e 同款），finally 清理。
    const ws = join(homedir(), `volund-test-ws-${basename(home)}`)
    await mkdir(ws, { recursive: true })
    process.env.VOLUND_HOME = home
    try {
      await expect(syncDaemonWithSwitch(home, true, { entry, cwd: ws })).resolves.toMatchObject({
        started: true,
      })
      // detached 子进程 boot 拿锁需要一点时间。
      let running = false
      for (let attempt = 0; attempt < 40 && !running; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        running = (await readDaemonStatus(home)).running
      }
      expect(running).toBe(true)
      // 再开一次：already-running no-op。
      await expect(syncDaemonWithSwitch(home, true, { entry, cwd: ws })).resolves.toMatchObject({
        alreadyRunning: true,
      })
      // 关：SIGTERM → 进程退（bin.ts 收尾），锁消失。
      await expect(syncDaemonWithSwitch(home, false, { entry, cwd: ws })).resolves.toMatchObject({
        stopped: true,
      })
      let stopped = false
      for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        stopped = !(await readDaemonStatus(home)).running
      }
      expect(stopped).toBe(true)
    } finally {
      delete process.env.VOLUND_HOME
      await stopDaemon(home).catch(() => undefined)
      await rm(ws, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)
})

describe('taskSectionsFromConfig', () => {
  it('defaults to disabled with sane clamps', () => {
    expect(taskSectionsFromConfig(undefined)).toEqual({
      enabled: false,
      maxConcurrent: 1,
      journalRetention: 200,
    })
    expect(
      taskSectionsFromConfig({
        tasks: { enabled: true, max_concurrent: 99, journal_retention: 1 },
      }),
    ).toEqual({ enabled: true, maxConcurrent: 8, journalRetention: 10 })
  })

  it('parses webhook_url only when non-empty', () => {
    expect(
      taskSectionsFromConfig({
        tasks: { enabled: true, webhook_url: 'https://hooks.example/volund' },
      }),
    ).toEqual({
      enabled: true,
      maxConcurrent: 1,
      journalRetention: 200,
      webhookUrl: 'https://hooks.example/volund',
    })
    expect(taskSectionsFromConfig({ tasks: { enabled: true, webhook_url: '' } })).toEqual({
      enabled: true,
      maxConcurrent: 1,
      journalRetention: 200,
    })
  })
})

describe('computeConfigHash', () => {
  it('hashes config.toml content and tolerates a missing file', async () => {
    const home = await tempHome()
    const empty = await computeConfigHash(home)
    await writeFile(join(home, 'config.toml'), '[provider]\nmodel = "m"\n')
    expect(await computeConfigHash(home)).not.toBe(empty)
    expect(await computeConfigHash(home)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('excludes the [tasks] section (ops surface) from the frozen hash', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'config.toml'), '[provider]\nmodel = "m1"\n')
    const baseline = await computeConfigHash(home)
    await writeFile(
      join(home, 'config.toml'),
      '[provider]\nmodel = "m1"\n[tasks]\nenabled = true\nwebhook_url = "https://hooks.example/volund"\n',
    )
    expect(await computeConfigHash(home)).toBe(baseline)
    await writeFile(
      join(home, 'config.toml'),
      '[provider]\nmodel = "m2"\n[tasks]\nenabled = true\n',
    )
    expect(await computeConfigHash(home)).not.toBe(baseline)
  })

  it('is insensitive to section and key order', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'config.toml'), '[a]\nx = 1\n[b]\ny = "z"\n')
    const first = await computeConfigHash(home)
    await writeFile(join(home, 'config.toml'), '[b]\ny = "z"\n[a]\nx = 1\n')
    expect(await computeConfigHash(home)).toBe(first)
  })
})

describe('createWebhookNotifier', () => {
  const notice: TaskRunNotice = {
    event: 'task.completed',
    taskId: 'job',
    taskName: 'Job',
    runId: 'run-1',
    scheduledFor: T0,
    finishedAt: T0,
  }

  it('skips delivery when no url is configured', async () => {
    let calls = 0
    const notifier = createWebhookNotifier({
      url: () => undefined,
      fetchFn: async () => {
        calls++
        return new Response('{}', { status: 200 })
      },
    })
    await notifier(notice)
    expect(calls).toBe(0)
  })

  it('posts the notice as JSON and succeeds on 2xx', async () => {
    const bodies: string[] = []
    const notifier = createWebhookNotifier({
      url: () => 'https://hooks.example/volund',
      fetchFn: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response('{}', { status: 200 })
      },
    })
    await notifier(notice)
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]!)).toMatchObject({ event: 'task.completed', taskId: 'job' })
  })

  it('retries 5xx with backoff and then succeeds', async () => {
    let calls = 0
    const sleeps: number[] = []
    const notifier = createWebhookNotifier({
      url: () => 'https://hooks.example/volund',
      fetchFn: async () => {
        calls++
        return new Response('{}', { status: calls === 1 ? 500 : 200 })
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    await notifier(notice)
    expect(calls).toBe(2)
    expect(sleeps).toEqual([500])
  })

  it('does not retry permanent 4xx responses', async () => {
    let calls = 0
    const notifier = createWebhookNotifier({
      url: () => 'https://hooks.example/volund',
      fetchFn: async () => {
        calls++
        return new Response('{}', { status: 404 })
      },
      sleep: async () => undefined,
    })
    await notifier(notice)
    expect(calls).toBe(1)
  })

  it('warns once after exhausting retries', async () => {
    const warns: { message: string; context?: Record<string, unknown> }[] = []
    let calls = 0
    const notifier = createWebhookNotifier({
      url: () => 'https://hooks.example/volund',
      maxAttempts: 2,
      logger: {
        warn: (message, context) => {
          warns.push({ message, ...(context ? { context } : {}) })
        },
      },
      fetchFn: async () => {
        calls++
        return new Response('{}', { status: 503 })
      },
      sleep: async () => undefined,
    })
    await notifier(notice)
    expect(calls).toBe(2)
    expect(warns).toHaveLength(1)
    expect(warns[0]?.message).toBe('task webhook delivery failed')
  })
})

describe('createProcessTaskRunner', () => {
  it('rejects on spawn failure (missing entry / cwd)', async () => {
    const runner = createProcessTaskRunner({ execArgv: ['definitely-missing-entry.cjs'] })
    await expect(
      runner(definition({ cwd: '/definitely/missing/dir' }), T0, 'run-1'),
    ).rejects.toThrow()
  })
})

describe('readDaemonStatus', () => {
  it('reports the live lock owner and cleared state', async () => {
    const { daemon, home } = await harness()
    expect(await readDaemonStatus(home)).toEqual({ running: false })
    await daemon.boot()
    expect(await readDaemonStatus(home)).toEqual({ running: true, pid: process.pid })
    await daemon.stop()
    expect(await readDaemonStatus(home)).toEqual({ running: false })
  })

  it('treats an unreadable or dead-pid lock as not running', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'daemon.lock'), 'garbage')
    expect(await readDaemonStatus(home)).toEqual({ running: false })
    await writeFile(join(home, 'daemon.lock'), JSON.stringify({ pid: 2 ** 30 }))
    expect(await readDaemonStatus(home)).toEqual({ running: false })
  })
})

describe('VolundError contract', () => {
  it('carries the registry code for daemon single-instance', () => {
    const error = new VolundError('task_daemon_running', 'busy')
    expect(error.code).toBe('task_daemon_running')
  })
})
