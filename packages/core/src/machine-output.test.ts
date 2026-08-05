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
      event('stream.delta', { chunk: { kind: 'message.start', messageId: 'message-1' } }),
      event('stream.delta', { chunk: { kind: 'text.delta', text: 'hello' } }),
      event('stream.delta', { chunk: { kind: 'usage', usage: { input: 1, output: 2 } } }),
      event('turn.completed', {}),
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
      event('stream.delta', { chunk: { kind: 'message.start', messageId: 'message-1' } }),
      event('stream.delta', { chunk: { kind: 'text.delta', text: 'hello' } }),
      event('stream.delta', { chunk: { kind: 'tool_use.start', id: 'tool-1', name: 'Read' } }),
      event('tool.completed', { toolUseId: 'tool-1', content: [{ type: 'text', text: 'ok' }] }),
      event('router.switched', { from: 'a', to: 'b', reason: 'retry' }),
      event('stream.delta', { chunk: { kind: 'usage', usage: { input: 1, output: 2 } } }),
      event('error.raised', { code: 'provider_timeout', category: 'provider', retryable: true }),
      event('turn.completed', {}),
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
    expect(output[6]?.data).toMatchObject({
      code: 'provider_timeout',
      category: 'provider',
      retryable: true,
      exitCode: 1,
    })
  })

  it('redacts secrets before serialization', () => {
    const formatter = new MachineEventFormatter()
    const output = formatter.format(
      event('tool.completed', { token: 'raw-token', content: 'Bearer raw-token' }),
    )
    expect(JSON.stringify(output)).not.toContain('raw-token')
    expect(JSON.stringify(output)).toContain('[REDACTED]')
  })

  it('uses the interrupted exit contract for an aborted turn', () => {
    const output = new MachineEventFormatter().format(event('turn.aborted', {}))
    expect(output).toMatchObject({ type: 'final', data: { status: 'cancelled', exitCode: 130 } })
  })
})
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
