import type { TaskDefinition, TaskSchedule } from '@volund/shared'
import { describe, expect, it } from 'vitest'

import { computeNextRunAt, evaluateTick } from '../scheduler-domain'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function definition(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'nightly-sync',
    name: 'Nightly sync',
    enabled: true,
    prompt: 'pull main and run tests',
    cwd: '/home/me/repo',
    schedule: { kind: 'interval', everyMs: 300_000 },
    timezone: 'UTC',
    missedRun: 'skip',
    overlap: 'skip',
    createdAt: Date.UTC(2026, 0, 15, 10),
    ...overrides,
  }
}

describe('computeNextRunAt', () => {
  it('anchors interval schedules on the cursor itself', () => {
    const schedule: TaskSchedule = { kind: 'interval', everyMs: 300_000 }
    expect(computeNextRunAt(schedule, 1_000_000)).toBe(1_300_000)
  })

  it('finds the next daily wall-clock occurrence in UTC', () => {
    const schedule: TaskSchedule = { kind: 'daily', at: '09:30' }
    // 2026-01-15 is a Thursday; 01:00Z 同日 09:30 之前 → 当日。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 15, 1), 'UTC')).toBe(
      Date.UTC(2026, 0, 15, 9, 30),
    )
    // 10:00Z 已过当日 09:30 → 次日。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 15, 10), 'UTC')).toBe(
      Date.UTC(2026, 0, 16, 9, 30),
    )
  })

  it('honors weekday sets for weekly schedules', () => {
    const schedule: TaskSchedule = { kind: 'weekly', weekdays: [1, 3, 5], at: '09:00' }
    // 2026-01-15（周四）10:00Z → 周五 09:00。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 15, 10), 'UTC')).toBe(
      Date.UTC(2026, 0, 16, 9),
    )
    // 周五 10:00Z 已过 → 跨到周一。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 16, 10), 'UTC')).toBe(
      Date.UTC(2026, 0, 19, 9),
    )
  })

  it('resolves wall clock in the task timezone, not the host timezone', () => {
    const schedule = { kind: 'daily', at: '09:00' } as const
    // Asia/Shanghai（+08:00）：09:00 墙钟 = 01:00Z。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 15, 0, 30), 'Asia/Shanghai')).toBe(
      Date.UTC(2026, 0, 15, 1),
    )
    expect(computeNextRunAt(schedule, Date.UTC(2026, 0, 15, 2), 'Asia/Shanghai')).toBe(
      Date.UTC(2026, 0, 16, 1),
    )
  })

  it('skips a nonexistent wall-clock time on the DST spring-forward day', () => {
    const schedule = { kind: 'daily', at: '02:30' } as const
    // America/New_York 2026-03-08 02:00→03:00：02:30 不存在 → 顺延到 03-09
    // 02:30 EDT（= 06:30Z）；03-07 正常日为 02:30 EST（= 07:30Z）。
    expect(computeNextRunAt(schedule, Date.UTC(2026, 2, 7, 12), 'America/New_York')).toBe(
      Date.UTC(2026, 2, 9, 6, 30),
    )
    expect(computeNextRunAt(schedule, Date.UTC(2026, 5, 1, 12), 'America/New_York')).toBe(
      Date.UTC(2026, 5, 2, 6, 30),
    )
  })
})

describe('evaluateTick', () => {
  it('fires due windows from the createdAt anchor on a fresh boot', () => {
    const task = definition()
    const result = evaluateTick({
      now: task.createdAt + 2.5 * 300_000,
      bootAt: task.createdAt,
      tasks: [task],
      cursors: {},
    })
    expect(result.fires.map((fire) => fire.scheduledFor)).toEqual([
      task.createdAt + 300_000,
      task.createdAt + 600_000,
    ])
    expect(result.fires.every((fire) => !fire.queued)).toBe(true)
    expect(result.missed).toEqual([])
  })

  it('advances from the persisted cursor, not createdAt', () => {
    const task = definition()
    const fired = task.createdAt + 300_000
    const result = evaluateTick({
      now: task.createdAt + 5 * 300_000,
      bootAt: task.createdAt,
      tasks: [task],
      cursors: { [task.id]: fired },
    })
    expect(result.fires.map((fire) => fire.scheduledFor)).toEqual([
      task.createdAt + 2 * 300_000,
      task.createdAt + 3 * 300_000,
      task.createdAt + 4 * 300_000,
      task.createdAt + 5 * 300_000,
    ])
  })

  it('ignores disabled tasks and idle schedules', () => {
    const result = evaluateTick({
      now: Date.UTC(2026, 0, 15, 11),
      bootAt: Date.UTC(2026, 0, 15, 10),
      tasks: [
        definition({ id: 'off', enabled: false }),
        definition({ id: 'idle', schedule: { kind: 'daily', at: '23:50' } }),
      ],
      cursors: {},
    })
    expect(result).toEqual({ fires: [], missed: [], skipped: [] })
  })

  it('classifies pre-boot windows as missed: skip policy only advances the cursor', () => {
    const task = definition({ schedule: { kind: 'daily', at: '09:00' } })
    const bootAt = Date.UTC(2026, 0, 20, 12)
    const result = evaluateTick({
      now: bootAt + 1_000,
      bootAt,
      tasks: [task],
      // cursor 已推进到 01-16 09:00 → 01-17/18/19/20 四个窗口全部早于 boot。
      cursors: { [task.id]: Date.UTC(2026, 0, 16, 9) },
    })
    expect(result.fires).toEqual([])
    expect(result.missed).toHaveLength(1)
    expect(result.missed[0]).toMatchObject({
      scheduledFor: Date.UTC(2026, 0, 20, 9),
      count: 4,
      fires: false,
    })
  })

  it('upgrades the latest missed window to a fire under run_latest', () => {
    const task = definition({
      schedule: { kind: 'daily', at: '09:00' },
      missedRun: 'run_latest',
    })
    const bootAt = Date.UTC(2026, 0, 20, 12)
    const result = evaluateTick({
      now: bootAt + 1_000,
      bootAt,
      tasks: [task],
      cursors: { [task.id]: Date.UTC(2026, 0, 16, 9) },
    })
    expect(result.fires).toHaveLength(1)
    expect(result.fires[0]).toMatchObject({ scheduledFor: Date.UTC(2026, 0, 20, 9), queued: false })
    expect(result.missed[0]).toMatchObject({ count: 4, fires: true })
  })

  it('drops in-flight due windows under overlap=skip and queues them under queue', () => {
    const task = definition()
    const input = {
      now: task.createdAt + 2.5 * 300_000,
      bootAt: task.createdAt,
      tasks: [task],
      cursors: {},
      runningTaskIds: new Set([task.id]),
    }
    expect(evaluateTick(input).skipped.map((skip) => skip.scheduledFor)).toEqual([
      task.createdAt + 300_000,
      task.createdAt + 600_000,
    ])
    const queued = evaluateTick({ ...input, tasks: [definition({ overlap: 'queue' })] })
    expect(queued.fires.every((fire) => fire.queued)).toBe(true)
    expect(queued.skipped).toEqual([])
  })

  it('never spawns a catch-up while another run is in flight under overlap=skip', () => {
    const task = definition({
      schedule: { kind: 'daily', at: '09:00' },
      missedRun: 'run_latest',
    })
    const bootAt = Date.UTC(2026, 0, 20, 12)
    const result = evaluateTick({
      now: bootAt + 1_000,
      bootAt,
      tasks: [task],
      cursors: { [task.id]: Date.UTC(2026, 0, 16, 9) },
      runningTaskIds: new Set([task.id]),
    })
    expect(result.fires).toEqual([])
    expect(result.missed[0]).toMatchObject({ fires: false })
  })

  it('caps window enumeration so extreme downtime cannot explode a tick', () => {
    const task = definition({ schedule: { kind: 'interval', everyMs: 60_000 } })
    const result = evaluateTick({
      now: task.createdAt + 100 * DAY_MS,
      bootAt: task.createdAt + 99 * DAY_MS,
      tasks: [task],
      cursors: {},
    })
    // 99 天 ≈ 142,560 个错过窗口：枚举截断在 1000，逐 tick 追账。
    expect(result.missed[0]?.count).toBe(1000)
    expect(result.fires).toEqual([])
  })

  it('splits missed and due windows across the boot boundary', () => {
    const task = definition({ schedule: { kind: 'daily', at: '09:00' }, missedRun: 'run_latest' })
    const result = evaluateTick({
      now: Date.UTC(2026, 0, 17, 10),
      bootAt: Date.UTC(2026, 0, 17, 8),
      tasks: [task],
      cursors: { [task.id]: Date.UTC(2026, 0, 15, 9) },
    })
    // 01-16 09:00 早于 boot（停机错过）→ run_latest 补跑；01-17 09:00 在 boot
    // 之后 → 正常触发。两个 fire，互不吞并。
    expect(result.missed[0]).toMatchObject({
      scheduledFor: Date.UTC(2026, 0, 16, 9),
      count: 1,
      fires: true,
    })
    expect(result.fires.map((fire) => fire.scheduledFor)).toEqual([
      Date.UTC(2026, 0, 16, 9),
      Date.UTC(2026, 0, 17, 9),
    ])
  })

  it('fires a post-boot late window as due, not missed', () => {
    const task = definition({ schedule: { kind: 'daily', at: '09:00' } })
    const bootAt = Date.UTC(2026, 0, 17, 8)
    const result = evaluateTick({
      // 09:00 窗口在 boot 之后（daemon 活着，只是 tick 晚点）→ 正常触发。
      now: Date.UTC(2026, 0, 17, 10),
      bootAt,
      tasks: [task],
      cursors: { [task.id]: Date.UTC(2026, 0, 16, 9) },
    })
    expect(result.fires.map((fire) => fire.scheduledFor)).toEqual([Date.UTC(2026, 0, 17, 9)])
    expect(result.missed).toEqual([])
  })

  it('keeps interval math timezone-independent across a whole day', () => {
    const task = definition({
      schedule: { kind: 'interval', everyMs: HOUR_MS },
      timezone: 'Asia/Shanghai',
    })
    const result = evaluateTick({
      now: task.createdAt + DAY_MS,
      bootAt: task.createdAt,
      tasks: [task],
      cursors: {},
    })
    expect(result.fires).toHaveLength(24)
  })
})
