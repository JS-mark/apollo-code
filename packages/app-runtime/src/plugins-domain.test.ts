import { rm } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { broadcastPluginLifecycleHook } from './plugins-domain'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** broadcast 是 void 派发：让出微任务让 reject 的 catch 落地。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Recorded {
  name: string
  event: string
  payload: unknown
}

function pluginEntry(
  name: string,
  events: readonly string[],
  recorded: Recorded[],
  fail = false,
): {
  name: string
  handle?: {
    hooks: readonly { event: string; plugin: string; invoke(payload: unknown): Promise<unknown> }[]
  }
} {
  return {
    name,
    handle: {
      hooks: events.map((event) => ({
        event,
        plugin: name,
        invoke: (payload: unknown) => {
          recorded.push({ name, event, payload })
          if (fail) return Promise.reject(new Error('boom'))
          return Promise.resolve(undefined)
        },
      })),
    },
  }
}

describe('broadcastPluginLifecycleHook', () => {
  it('maps session lifecycle events to sessionStart/sessionEnd with envelope payload', () => {
    const recorded: Recorded[] = []
    broadcastPluginLifecycleHook(
      { type: 'session.started', sessionId: 's1', payload: {} },
      [pluginEntry('p', ['sessionStart', 'sessionEnd'], recorded)],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      { type: 'session.ended', sessionId: 's1', payload: {} },
      [pluginEntry('p', ['sessionStart', 'sessionEnd'], recorded)],
      { warn: () => undefined },
    )
    expect(recorded).toEqual([
      { name: 'p', event: 'sessionStart', payload: { schemaVersion: 1, sessionId: 's1' } },
      { name: 'p', event: 'sessionEnd', payload: { schemaVersion: 1, sessionId: 's1' } },
    ])
  })

  it('passes task terminal events through by name with payload + sessionId (W-17 r1.5)', () => {
    const recorded: Recorded[] = []
    const subscriber = pluginEntry(
      'relay',
      ['task.started', 'task.completed', 'task.failed'],
      recorded,
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.started',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1 },
      },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.completed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5 },
      },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.failed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5, reason: 'error' },
      },
      [subscriber],
      { warn: () => undefined },
    )
    expect(recorded.map((row) => row.event)).toEqual([
      'task.started',
      'task.completed',
      'task.failed',
    ])
    expect(recorded[1]?.payload).toEqual({
      schemaVersion: 1,
      sessionId: 's1',
      taskId: 'job',
      runId: 'r1',
      scheduledFor: 1,
      durationMs: 5,
    })
  })

  it('ignores unrelated events and non-object task payloads stay envelope-only', () => {
    const recorded: Recorded[] = []
    const subscriber = pluginEntry('p', ['task.completed', 'sessionStart'], recorded)
    broadcastPluginLifecycleHook(
      { type: 'turn.completed', sessionId: 's1', payload: {} },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      { type: 'task.completed', sessionId: 's1', payload: null },
      [subscriber],
      { warn: () => undefined },
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.payload).toEqual({ schemaVersion: 1, sessionId: 's1' })
  })

  it('is fail-open: a throwing handler warns but does not affect other subscribers', async () => {
    const recorded: Recorded[] = []
    const warns: string[] = []
    broadcastPluginLifecycleHook(
      {
        type: 'task.completed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5 },
      },
      [
        pluginEntry('bad', ['task.completed'], recorded, true),
        pluginEntry('good', ['task.completed'], recorded),
      ],
      { warn: (message) => warns.push(message) },
    )
    await flush()
    expect(recorded.map((row) => row.name)).toEqual(['bad', 'good'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('plugin hook task.completed from bad failed')
  })
})
