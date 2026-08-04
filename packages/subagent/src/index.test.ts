import { createSession, EventBus, type Runner } from '@apollo-code/core'
import { describe, expect, it, vi } from 'vitest'

import { SubagentDispatcher } from './index'

const parent = (depth = 0, signal = new AbortController().signal) => ({
  state: createSession({
    id: `parent-${depth}`,
    cwd: '/workspace',
    maxTokens: 100,
    toolRegistrySnapshot: 'tools',
    lineage: { depth },
  }),
  events: new EventBus(),
  turnId: 'parent-turn',
  signal,
})

function fakeRunner(run: Runner['run']): Runner {
  return { run, interrupt: vi.fn() } as unknown as Runner
}

describe('SubagentDispatcher', () => {
  it('creates an isolated child and bubbles tagged events', async () => {
    let childState: ReturnType<typeof createSession> | undefined
    const seen: unknown[] = []
    const p = parent()
    p.events.subscribe((event) => {
      seen.push(event.payload)
    })
    const dispatcher = new SubagentDispatcher({
      runnerFactory(state, events) {
        childState = state
        return fakeRunner(async () => {
          await events.emit({
            type: 'turn.started',
            version: 1,
            sessionId: state.id,
            payload: { safe: true },
          })
          return {
            ...state,
            messages: [
              {
                id: 'm',
                role: 'assistant',
                createdAt: 1,
                content: [{ type: 'text', text: 'done' }],
              },
            ],
          }
        })
      },
    })
    await expect(dispatcher.dispatch(p, { prompt: 'work' })).resolves.toMatchObject({
      text: 'done',
    })
    expect(childState?.messages).toEqual([])
    expect(childState?.id).not.toBe(p.state.id)
    expect(childState?.lineage).toMatchObject({ depth: 1, parentSessionId: p.state.id })
    expect(seen).toContainEqual(expect.objectContaining({ parentTurnId: 'parent-turn', depth: 1 }))
  })

  it('allows depths one through three and rejects depth four', async () => {
    const dispatcher = new SubagentDispatcher({
      runnerFactory: (state) => fakeRunner(async () => state),
    })
    for (const depth of [0, 1, 2])
      await expect(dispatcher.dispatch(parent(depth), { prompt: 'ok' })).resolves.toBeDefined()
    await expect(dispatcher.dispatch(parent(3), { prompt: 'no' })).rejects.toMatchObject({
      code: 'APOLLO_SUBAGENT_DEPTH_EXCEEDED',
    })
  })

  it('cascades cancellation and leaves no orphan', async () => {
    const controller = new AbortController()
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const runner = fakeRunner(async () => {
      await pending
      return parent().state
    })
    const dispatcher = new SubagentDispatcher({ runnerFactory: () => runner })
    const result = dispatcher.dispatch(parent(0, controller.signal), { prompt: 'wait' })
    await vi.waitFor(() => expect(dispatcher.activeCount).toBe(1))
    controller.abort()
    release()
    await expect(result).resolves.toMatchObject({ status: 'cancelled' })
    expect(runner.interrupt).toHaveBeenCalledOnce()
    expect(dispatcher.activeCount).toBe(0)
  })

  it('bounds fan-out concurrency', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const dispatcher = new SubagentDispatcher({
      maxConcurrency: 1,
      runnerFactory: (state) =>
        fakeRunner(async () => {
          await pending
          return state
        }),
    })
    const first = dispatcher.dispatch(parent(), { prompt: 'one' })
    await vi.waitFor(() => expect(dispatcher.activeCount).toBe(1))
    await expect(dispatcher.dispatch(parent(), { prompt: 'two' })).rejects.toMatchObject({
      code: 'APOLLO_SUBAGENT_CONCURRENCY_EXCEEDED',
    })
    release()
    await first
  })
})
