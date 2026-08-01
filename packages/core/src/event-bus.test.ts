import { describe, expect, it, vi } from 'vitest'

import { EventBus, eventTypes, idempotentSubscriber } from './event-bus'

describe('EventBus', () => {
  it('exposes the complete L1 event contract', () => {
    expect(eventTypes).toHaveLength(17)
  })
  it('emits ordered UUIDv7 events', async () => {
    const bus = new EventBus()
    const first = await bus.emit({
      type: 'session.started',
      version: 1,
      sessionId: 's',
      payload: {},
    })
    const second = await bus.emit({
      type: 'session.ended',
      version: 2,
      sessionId: 's',
      payload: {},
    })
    expect(first.id[14]).toBe('7')
    expect(first.id < second.id).toBe(true)
  })
  it('deduplicates replayed events per subscriber', async () => {
    const listener = vi.fn()
    const safe = idempotentSubscriber(listener)
    const event = {
      id: 'same',
      type: 'session.started' as const,
      version: 1,
      sessionId: 's',
      payload: {},
      at: 1,
    }
    await safe(event)
    await safe(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
