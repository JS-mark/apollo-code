import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TASK_STORE_SCHEMA_VERSION, TaskStore, type TaskRunRecord } from './task-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempStore(options?: ConstructorParameters<typeof TaskStore>[1]) {
  const dir = await mkdtemp(join(tmpdir(), 'volund-tasks-'))
  directories.push(dir)
  return new TaskStore(join(dir, 'tasks.json'), options)
}

const definition = {
  id: 'nightly-sync',
  name: 'Nightly sync',
  enabled: true,
  prompt: 'pull main and run tests',
  cwd: '/home/me/repo',
  schedule: { kind: 'daily', at: '03:30' },
  missedRun: 'skip',
  overlap: 'skip',
  createdAt: 1_700_000_000_000,
} as const

function runRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    runId: 'run-1',
    taskId: definition.id,
    status: 'running',
    scheduledFor: 1_700_000_100_000,
    ...overrides,
  }
}

describe('TaskStore definitions', () => {
  it('starts empty and round-trips an upserted task', async () => {
    const store = await tempStore()
    expect(await store.listTasks()).toEqual([])

    const saved = await store.upsertTask(definition)
    expect(saved.id).toBe(definition.id)
    expect(await store.getTask('nightly-sync')).toEqual(saved)

    const updated = await store.upsertTask({ ...definition, enabled: false })
    expect(await store.listTasks()).toEqual([updated])
    expect(updated.enabled).toBe(false)
  })

  it('rejects invalid definitions with task_definition_invalid', async () => {
    const store = await tempStore()
    await expect(store.upsertTask({ ...definition, id: 'BAD' })).rejects.toMatchObject({
      name: 'TaskError',
      code: 'task_definition_invalid',
    })
    await expect(store.listTasks()).resolves.toEqual([])
  })

  it('removes a task and its cursor', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await store.recordRun(runRecord())
    expect(await store.removeTask('nightly-sync')).toBe(true)
    expect(await store.removeTask('nightly-sync')).toBe(false)
    const snapshot = await store.loadSnapshot()
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.cursors).toEqual({})
  })
})

describe('TaskStore journal', () => {
  it('records runs, advances the per-task cursor and applies retention', async () => {
    const store = await tempStore({ journalRetention: 2 })
    await store.upsertTask(definition)
    await store.recordRun(runRecord({ runId: 'run-1', scheduledFor: 1_000 }))
    await store.recordRun(runRecord({ runId: 'run-2', scheduledFor: 2_000 }))
    await store.recordRun(runRecord({ runId: 'run-3', scheduledFor: 1_500 }))

    const snapshot = await store.loadSnapshot()
    expect(snapshot.runs.map((run) => run.runId)).toEqual(['run-2', 'run-3'])
    // 游标取 max（乱序写入不回退），与 retention 无关。
    expect(snapshot.cursors['nightly-sync']).toBe(2_000)
  })

  it('merges run patches without writing explicit undefined (exactOptionalPropertyTypes)', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await store.recordRun(runRecord())
    const finished = await store.updateRun('run-1', {
      status: 'completed',
      finishedAt: 1_700_000_200_000,
      exitCode: 0,
    })
    expect(finished).toMatchObject({
      status: 'completed',
      exitCode: 0,
      scheduledFor: 1_700_000_100_000,
    })
    expect(await store.updateRun('missing', { status: 'failed' })).toBeUndefined()
  })

  it('lists recent runs newest-first with optional task filter', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await store.upsertTask({ ...definition, id: 'other' })
    await store.recordRun(runRecord({ runId: 'a', scheduledFor: 1_000 }))
    await store.recordRun(runRecord({ runId: 'b', scheduledFor: 2_000, taskId: 'other' }))
    await store.recordRun(runRecord({ runId: 'c', scheduledFor: 3_000 }))

    expect((await store.recentRuns({ limit: 2 })).map((run) => run.runId)).toEqual(['c', 'b'])
    expect((await store.recentRuns({ taskId: 'other' })).map((run) => run.runId)).toEqual(['b'])
  })
})

describe('TaskStore durability', () => {
  it('serializes concurrent writers and keeps the snapshot consistent', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.recordRun(runRecord({ runId: `run-${index}`, scheduledFor: index })),
      ),
    )
    const snapshot = await store.loadSnapshot()
    expect(snapshot.runs).toHaveLength(12)
    expect(snapshot.cursors['nightly-sync']).toBe(11)
  })

  it('recovers from the .bak backup when the snapshot is corrupt', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await store.recordRun(runRecord())

    // 模拟写入中断：快照被截断，.bak 仍完好（saveUnlocked 的 rename 顺序保证）。
    await writeFile(`${store.path}.bak`, JSON.stringify(await store.loadSnapshot()))
    await writeFile(store.path, '{"schemaVersion": "volund.tasks')

    expect(await store.listTasks()).toHaveLength(1)
  })

  it('throws task_store_corrupt when snapshot and backup are both unreadable', async () => {
    const store = await tempStore()
    await writeFile(store.path, 'not json')
    await writeFile(`${store.path}.bak`, 'also not json')
    await expect(store.listTasks()).rejects.toMatchObject({
      name: 'TaskError',
      code: 'task_store_corrupt',
    })
  })

  it('throws task_store_corrupt on an unknown schema version', async () => {
    const store = await tempStore()
    await writeFile(store.path, JSON.stringify({ schemaVersion: 'volund.tasks.v999' }))
    await expect(store.loadSnapshot()).rejects.toMatchObject({ code: 'task_store_corrupt' })
  })

  it('times out against a live foreign lock with task_io', async () => {
    const store = await tempStore({ lockTimeoutMs: 80, lockRetryMs: 5 })
    // 持锁者写本测试进程自己的 pid → lockOwnerAlive 判存活 → 不做 stale 回收。
    const lock = await open(`${store.path}.lock`, 'wx', 0o600)
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: 'foreign' }))
    await lock.close()
    await expect(store.listTasks()).rejects.toMatchObject({
      name: 'TaskError',
      code: 'task_io',
    })
  })

  it('reclaims a stale lock left by a dead process', async () => {
    const store = await tempStore({ lockTimeoutMs: 200, lockRetryMs: 5 })
    // pid 取不可能存在的值 → kill(pid, 0) ESRCH → 视为死进程 → 回收后继续。
    const lock = await open(`${store.path}.lock`, 'wx', 0o600)
    await lock.writeFile(JSON.stringify({ pid: 2 ** 30, token: 'stale' }))
    await lock.close()
    await expect(store.listTasks()).resolves.toEqual([])
  })

  it('writes schema-versioned snapshots readable after a reload', async () => {
    const store = await tempStore()
    await store.upsertTask(definition)
    await store.recordRun(runRecord())
    const raw = JSON.parse(await readFile(store.path, 'utf8')) as { schemaVersion?: string }
    expect(raw.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION)
    expect(await store.getTask(definition.id)).toMatchObject({ id: definition.id })
  })
})
