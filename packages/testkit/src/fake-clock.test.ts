import { describe, expect, it, vi } from 'vitest'

import { fakeClock } from './fake-clock'

describe('fakeClock', () => {
  it('does not fire a timer before its deadline is advanced past', async () => {
    await fakeClock(async (clock) => {
      const fired: string[] = []
      setTimeout(() => fired.push('timeout'), 5000)
      expect(fired).toEqual([])
      await clock.advance(4999)
      expect(fired).toEqual([])
      await clock.advance(1)
      expect(fired).toEqual(['timeout'])
    })
  })

  it('flushes microtasks queued inside timer callbacks before advance resolves', async () => {
    await fakeClock(async (clock) => {
      let observed = ''
      setTimeout(() => {
        observed += 'timer:'
        // 悬浮微任务是本用例的被测对象：advance() 必须把它 flush 掉
        void Promise.resolve().then(() => {
          observed += 'microtask'
        })
      }, 100)
      await clock.advance(100)
      expect(observed).toBe('timer:microtask')
    })
  })

  it('fires interval timers across successive advance windows', async () => {
    await fakeClock(async (clock) => {
      let ticks = 0
      const timer = setInterval(() => {
        ticks += 1
      }, 1000)
      await clock.advance(2500)
      clearInterval(timer)
      expect(ticks).toBe(2)
    })
  })

  it('advances the mocked Date alongside the timers', async () => {
    await fakeClock(
      async (clock) => {
        const before = clock.now()
        await clock.advance(6000)
        expect(clock.now() - before).toBe(6000)
      },
      { now: 1_000_000 },
    )
  })

  it('installs fake timers for the callback and restores real timers afterwards', async () => {
    expect(vi.isFakeTimers()).toBe(false)
    await fakeClock(async () => {
      expect(vi.isFakeTimers()).toBe(true)
    })
    expect(vi.isFakeTimers()).toBe(false)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })

  it('restores real timers when the callback throws', async () => {
    await expect(
      fakeClock(async () => {
        setTimeout(() => {}, 1000)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(vi.isFakeTimers()).toBe(false)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })

  it('restore() is idempotent and safe to call alongside the wrapper teardown', async () => {
    await fakeClock((clock) => {
      clock.restore()
      clock.restore()
      expect(vi.isFakeTimers()).toBe(false)
    })
    expect(vi.isFakeTimers()).toBe(false)
  })

  it('runAll drains every pending timer including rescheduled ones', async () => {
    await fakeClock(async (clock) => {
      const fired: number[] = []
      const tick = (count: number) => () => {
        fired.push(count)
        if (count < 3) setTimeout(tick(count + 1), 10)
      }
      setTimeout(tick(1), 10)
      await clock.runAll()
      expect(fired).toEqual([1, 2, 3])
    })
  })
})
