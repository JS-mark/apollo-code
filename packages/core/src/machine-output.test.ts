import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { CoreEvent } from './event-bus'
import { MachineEventFormatter } from './machine-output'

const base = {
  id: 'event-1',
  version: 1,
  sessionId: 'session-1',
  turnId: 'turn-1',
  at: Date.parse('2026-08-05T00:00:00.000Z'),
}

function event(type: CoreEvent['type'], payload: CoreEvent['payload']): CoreEvent {
  return { ...base, type, payload }
}

describe('MachineEventFormatter', () => {
  it('matches the text stream golden file byte-for-byte', () => {
    const formatter = new MachineEventFormatter()
    const actual = [
      event('stream.started', { messageId: 'message-1', provider: 'p', model: 'm' }),
      event('stream.delta', { messageId: 'message-1', kind: 'text', fragment: 'hello' }),
      event('stream.completed', { messageId: 'message-1', usage: { input: 1, output: 2 } }),
      event('turn.completed', {
        turnId: 'turn-1',
        usage: { input: 1, output: 2 },
        stopReason: 'end_turn',
      }),
    ]
      .map((item) => formatter.encode(item))
      .join('')
    const golden = readFileSync(
      fileURLToPath(new URL('./__fixtures__/text-stream.ndjson', import.meta.url)),
      'utf8',
    )
    expect(actual).toBe(golden)
  })

  it('formats ordered text, tool, router, usage, error, and final events', () => {
    const formatter = new MachineEventFormatter()
    const output = [
      event('stream.started', { messageId: 'message-1' }),
      event('stream.delta', { messageId: 'message-1', kind: 'text', fragment: 'hello' }),
      event('tool.requested', { toolUseId: 'tool-1', tool: 'Read', input: { path: 'a' } }),
      event('tool.completed', {
        toolUseId: 'tool-1',
        tool: 'Read',
        isError: false,
        durationMs: 3,
      }),
      event('router.switched', { from: 'a', to: 'b', reason: 'retry' }),
      event('stream.completed', { messageId: 'message-1', usage: { input: 1, output: 2 } }),
      event('error.raised', {
        code: 'provider_timeout',
        category: 'provider',
        context: { message: 'timed out' },
      }),
      event('turn.completed', { turnId: 'turn-1', usage: { input: 1, output: 2 } }),
    ].map((item) => formatter.format(item))

    expect(output.map((item) => item?.type)).toEqual([
      'message.start',
      'text.delta',
      'tool_use',
      'tool_result',
      'router.switched',
      'usage',
      'error',
      'final',
    ])
    expect(output.map((item) => item?.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(output[2]?.data).toMatchObject({ toolUseId: 'tool-1', tool: 'Read' })
    expect(output[6]?.data).toMatchObject({
      code: 'provider_timeout',
      category: 'provider',
      message: 'timed out',
      retryable: false,
      exitCode: 1,
    })
    expect(output[7]?.data).toMatchObject({ status: 'completed', exitCode: 0 })
  })

  it('skips thinking and tool_use delta fragments in the text stream', () => {
    const formatter = new MachineEventFormatter()
    expect(
      formatter.format(
        event('stream.delta', { messageId: 'm', kind: 'thinking', fragment: 'hmm' }),
      ),
    ).toBeUndefined()
    expect(
      formatter.format(event('stream.delta', { messageId: 'm', kind: 'tool_use', fragment: '{}' })),
    ).toBeUndefined()
    expect(formatter.format(event('stream.completed', { messageId: 'm' }))).toBeUndefined()
  })

  it('redacts secrets before serialization', () => {
    const formatter = new MachineEventFormatter()
    const output = formatter.format(
      event('tool.requested', { toolUseId: 't', tool: 'Bearer raw-token', input: {} }),
    )
    expect(JSON.stringify(output)).not.toContain('raw-token')
    expect(JSON.stringify(output)).toContain('[REDACTED]')
  })

  it('uses the interrupted exit contract for an aborted turn', () => {
    const formatter = new MachineEventFormatter()
    expect(
      formatter.format(event('turn.aborted', { turnId: 'turn-1', reason: 'user_interrupt' })),
    ).toMatchObject({ type: 'final', data: { status: 'cancelled', exitCode: 130 } })
    expect(
      formatter.format(event('turn.aborted', { turnId: 'turn-1', reason: 'error' })),
    ).toMatchObject({ type: 'final', data: { status: 'error', exitCode: 1 } })
    expect(
      formatter.format(event('turn.aborted', { turnId: 'turn-1', reason: 'stream_interrupted' })),
    ).toMatchObject({ type: 'final', data: { status: 'error', exitCode: 1 } })
  })
})
