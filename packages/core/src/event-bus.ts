import { v7 as uuidv7 } from 'uuid'
import type { JsonValue } from '@apollo-code/shared'

export const eventTypes = [
  'session.started', 'session.ended', 'turn.started', 'turn.completed', 'turn.aborted',
  'message.appended', 'stream.started', 'stream.delta', 'stream.completed', 'tool.requested',
  'tool.permission_asked', 'tool.started', 'tool.completed', 'context.compacted', 'router.switched',
  'error.raised', 'session.resumed',
] as const
export type EventType = typeof eventTypes[number]
export interface CoreEvent<T extends EventType = EventType> {
  id: string; type: T; version: number; sessionId: string; turnId?: string; payload: JsonValue; at: number
}
export type EventListener = (event: CoreEvent) => void | Promise<void>

export class EventBus {
  readonly #listeners = new Set<EventListener>()
  subscribe(listener: EventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  async emit(input: Omit<CoreEvent, 'at' | 'id'>): Promise<CoreEvent> {
    const event: CoreEvent = { ...input, id: uuidv7(), at: Date.now() }
    await Promise.all([...this.#listeners].map(listener => listener(event)))
    return event
  }
}

export function idempotentSubscriber(listener: EventListener, capacity = 10_000): EventListener {
  const seen = new Map<string, true>()
  return async (event) => {
    if (seen.has(event.id)) return
    seen.set(event.id, true)
    if (seen.size > capacity) seen.delete(seen.keys().next().value!)
    await listener(event)
  }
}
