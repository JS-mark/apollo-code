/**
 * 调度纯判定核心（W-17 / Web 计划 F1-01~04 的确定性半边）。
 *
 * 不碰时钟、不碰文件：`now` / 游标 / 在途集合由调用方注入，测试用
 * @volund/testkit 的 fake-clock 驱动。daemon 宿主（批次 2 的 `volund daemon`）
 * 拿 `evaluateTick` 的输出做三件事——spawn fire、记录 missed（游标随
 * TaskStore.recordRun 落盘）、记录 overlap skipped；本模块不持状态。
 *
 * 窗口枚举语义：游标 = 最近一次「应触发时刻」（TaskStore cursors，随
 * recordRun 推进）。早于本次 daemon boot 的窗口是停机错过窗口（F1-04），
 * 按任务 missedRun 策略处理；boot 之后的滞留窗口（事件循环晚点）正常触发。
 * 枚举上限 1000 窗口/任务/tick——超长停机由 daemon 逐 tick 追账（skip 策略
 * 每 tick 推进一批游标，不产生 spawn 风暴）。
 */
import { parseHhmm, type TaskDefinition, type TaskSchedule } from '@volund/shared'

const MINUTE_MS = 60_000
/** 单任务单 tick 的窗口枚举上限（计数即下界：超过按 1000 报）。 */
const MAX_WINDOWS_PER_TICK = 1000

export interface ScheduleTickInput {
  /** 当前时刻（epoch ms）。 */
  now: number
  /** 本次 daemon 进程的启动时刻：早于它的窗口按 missedRun 策略处理。 */
  bootAt: number
  tasks: readonly TaskDefinition[]
  /** 每任务调度游标（最近一次应触发时刻，epoch ms）；缺项 = 从未触发（锚 createdAt）。 */
  cursors: Readonly<Record<string, number>>
  /** 当前在途运行的任务 id 集合（daemon 报告）；overlap 判定用。 */
  runningTaskIds?: ReadonlySet<string>
}

export interface TaskFire {
  readonly task: TaskDefinition
  readonly scheduledFor: number
  /** overlap=queue 且上轮在途：daemon 须等在途释放后再 spawn。 */
  readonly queued: boolean
}

export interface TaskMissed {
  readonly task: TaskDefinition
  /** 最近一个错过窗口；run_latest 策略且未与 overlap 冲突时升级为触发。 */
  readonly scheduledFor: number
  /** 错过窗口数（枚举上限截断时即 1000，语义为「至少此数」）。 */
  readonly count: number
  /** true = daemon 应当 spawn 这次补跑。 */
  readonly fires: boolean
}

export interface TaskSkipped {
  readonly task: TaskDefinition
  readonly scheduledFor: number
  readonly reason: 'overlap'
}

export interface TaskTickResult {
  readonly fires: readonly TaskFire[]
  readonly missed: readonly TaskMissed[]
  readonly skipped: readonly TaskSkipped[]
}

/**
 * 调度序列里 `afterMs` 之后的下一次应触发时刻（epoch ms）。
 *
 * interval 是锚相对调度：返回 `afterMs + everyMs`（调用方以 createdAt 或上次
 * 应触发时刻为锚）。daily / weekly 锚墙钟：在 `timezone`（缺省宿主本地时区）
 * 的墙上钟 HH:MM 逐日找下一个匹配日。DST 缺失的墙钟时刻（春拨）当日不存在、
 * 顺延到下一个匹配日；重叠时刻（秋拨）取解算收敛侧的合法出现——两种情况都
 * 宁可少触发也不重复触发（F1-04 duplicate prevention 的保守偏置）。
 */
export function computeNextRunAt(
  schedule: TaskSchedule,
  afterMs: number,
  timezone?: string,
): number | undefined {
  if (schedule.kind === 'interval') return afterMs + schedule.everyMs
  const timeZone = timezone ?? hostTimeZone()
  const { hour, minute } = parseHhmm(schedule.at)
  const weekdays = schedule.kind === 'weekly' ? new Set(schedule.weekdays) : undefined
  return nextWallOccurrence({ hour, minute }, weekdays, afterMs, timeZone)
}

export function evaluateTick(input: ScheduleTickInput): TaskTickResult {
  const fires: TaskFire[] = []
  const missed: TaskMissed[] = []
  const skipped: TaskSkipped[] = []
  const running = input.runningTaskIds

  for (const task of input.tasks) {
    if (!task.enabled) continue
    const anchor = input.cursors[task.id] ?? task.createdAt
    const windows = enumerateWindows(task, anchor, input.now)
    if (windows.length === 0) continue

    const missedWindows = windows.filter((at) => at < input.bootAt)
    const dueWindows = windows.filter((at) => at >= input.bootAt)

    if (missedWindows.length > 0) {
      const latest = missedWindows[missedWindows.length - 1] as number
      const wantsFire = task.missedRun === 'run_latest'
      const blockedByOverlap = wantsFire && running?.has(task.id) === true
      if (wantsFire && !blockedByOverlap) {
        fires.push({ task, scheduledFor: latest, queued: false })
        missed.push({ task, scheduledFor: latest, count: missedWindows.length, fires: true })
      } else if (wantsFire && blockedByOverlap && task.overlap === 'queue') {
        // 在途但允许排队：窗口不丢，等在途释放后 spawn。
        fires.push({ task, scheduledFor: latest, queued: true })
        missed.push({ task, scheduledFor: latest, count: missedWindows.length, fires: true })
      } else {
        // skip 策略，或 run_latest 撞上 overlap=skip 的在途：仅推进游标。
        missed.push({ task, scheduledFor: latest, count: missedWindows.length, fires: false })
      }
    }

    for (const at of dueWindows) {
      if (running?.has(task.id)) {
        if (task.overlap === 'skip') skipped.push({ task, scheduledFor: at, reason: 'overlap' })
        else fires.push({ task, scheduledFor: at, queued: true })
      } else {
        fires.push({ task, scheduledFor: at, queued: false })
      }
    }
  }

  return { fires, missed, skipped }
}

/** 窗口枚举（上限 MAX_WINDOWS_PER_TICK）；窗口时刻严格大于锚点。 */
function enumerateWindows(task: TaskDefinition, anchor: number, now: number): number[] {
  const windows: number[] = []
  let cursor = anchor
  for (;;) {
    const next = computeNextRunAt(task.schedule, cursor, task.timezone)
    if (next === undefined || next > now) break
    windows.push(next)
    cursor = next
    if (windows.length >= MAX_WINDOWS_PER_TICK) break
  }
  return windows
}

/* ── 墙钟工具（Intl 驱动，无外部依赖；formatter 按时区缓存） ─────────────── */

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 0=Sunday（JS 约定）。 */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>()

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    wallFormatters.set(timeZone, formatter)
  }
  return formatter
}

function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const parts = wallFormatter(timeZone).formatToParts(new Date(epochMs))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? ''
    return Number(value)
  }
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun'
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    weekday: WEEKDAY_INDEX[weekdayName] ?? 0,
  }
}

/** 该时区在该瞬间的 UTC 偏移（分钟对齐）。 */
function tzOffsetMs(epochMs: number, timeZone: string): number {
  const wall = wallClockAt(epochMs, timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  return asUtc - Math.floor(epochMs / MINUTE_MS) * MINUTE_MS
}

function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * 严格大于 `afterMs` 的下一个「匹配日 + HH:MM」墙上钟瞬间。
 * 偏移用三步不动点收敛（时区偏移是阶梯函数，两次迭代即稳定）；解出的瞬间
 * 回读墙钟校验（DST 缺失时刻不匹配 → 顺延下一个匹配日）。
 */
function nextWallOccurrence(
  target: { hour: number; minute: number },
  weekdays: ReadonlySet<number> | undefined,
  afterMs: number,
  timeZone: string,
): number | undefined {
  const startDay = wallClockAt(afterMs, timeZone)
  for (let dayShift = 0; dayShift <= 8; dayShift++) {
    const day = wallClockAt(
      Date.UTC(startDay.year, startDay.month - 1, startDay.day + dayShift, 12),
      timeZone,
    )
    if (weekdays && !weekdays.has(day.weekday)) continue
    const wallMs = Date.UTC(day.year, day.month - 1, day.day, target.hour, target.minute)
    let candidate = wallMs - tzOffsetMs(afterMs, timeZone)
    for (let iteration = 0; iteration < 3; iteration++) {
      candidate = wallMs - tzOffsetMs(candidate, timeZone)
    }
    if (candidate <= afterMs) continue
    const solved = wallClockAt(candidate, timeZone)
    if (
      solved.year === day.year &&
      solved.month === day.month &&
      solved.day === day.day &&
      solved.hour === target.hour &&
      solved.minute === target.minute
    ) {
      return candidate
    }
    // DST 缺失的墙钟时刻：当日无此时刻，继续找下一个匹配日。
  }
  return undefined
}
