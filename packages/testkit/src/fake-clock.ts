import { vi } from 'vitest'

export interface FakeClockOptions {
  /** Value `Date.now()` returns once fake timers are installed. */
  readonly now?: number | Date
}

export interface FakeClock {
  /** Current (faked) epoch milliseconds. */
  now(): number
  /**
   * Advance the clock by `ms`, firing every timer whose deadline falls inside
   * the window and flushing microtasks queued by their callbacks between
   * timers. Repeated timers keep firing across later windows.
   */
  advance(ms: number): Promise<void>
  /** Fire every pending timer (including repeatedly-scheduled ones). */
  runAll(): Promise<void>
  /** Restore real timers early; the wrapper also restores on exit. */
  restore(): void
}

/**
 * Scoped vitest fake-timers wrapper (spec 06d-testkit §6.13.3).
 *
 * Installs fake timers for the duration of `fn` and restores real timers in a
 * `finally` — a leaked `vi.useFakeTimers()` cannot pollute later tests, and no
 * real `setTimeout` fires while the callback runs. Prefer this over calling
 * `vi.useFakeTimers()` directly so restore-on-throw is guaranteed.
 */
export async function fakeClock<T>(
  fn: (clock: FakeClock) => T | Promise<T>,
  options: FakeClockOptions = {},
): Promise<T> {
  vi.useFakeTimers(options.now === undefined ? undefined : { now: options.now })
  let active = true
  const restore = (): void => {
    if (!active) return
    active = false
    vi.useRealTimers()
  }
  const clock: FakeClock = {
    now: () => Date.now(),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms)
    },
    runAll: async () => {
      await vi.runAllTimersAsync()
    },
    restore,
  }
  try {
    return await fn(clock)
  } finally {
    restore()
  }
}
