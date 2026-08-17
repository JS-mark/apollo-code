import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { DEFAULT_IPC_MAX_LINE_BYTES, RpcPeer, type IpcTelemetry } from './ipc'

interface RecordedEvent {
  name: string
  source: string
  payload: Record<string, unknown>
}
function recordingTelemetry(): { events: RecordedEvent[]; telemetry: IpcTelemetry } {
  const events: RecordedEvent[] = []
  return {
    events,
    telemetry: {
      async emit(name, source, payload) {
        events.push({ name, source, payload })
      },
    },
  }
}
function readOutput(output: PassThrough): string {
  return (output.read() ?? Buffer.alloc(0)).toString('utf8')
}

describe('RpcPeer', () => {
  it('rejects malformed protocol frames without losing later frames', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new RpcPeer(input, output)
    const response = peer.requestWithId(1, 'fs.diff', {})
    input.write('not-json\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n')
    await expect(response).resolves.toBe('ok')
  })

  it('rejects a 5MB single line with -32600, keeps the channel alive, and records telemetry', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { events, telemetry } = recordingTelemetry()
    const peer = new RpcPeer(input, output, { telemetry })
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'search.query',
      params: { blob: 'x'.repeat(5 * 1024 * 1024) },
    })
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(DEFAULT_IPC_MAX_LINE_BYTES)
    const response = peer.requestWithId(1, 'fs.diff', {})
    input.write(`${oversized}\n{"jsonrpc":"2.0","id":1,"result":"still-alive"}\n`)
    await expect(response).resolves.toBe('still-alive')
    const errorFrame = readOutput(output)
      .split('\n')
      .map((line) => (line ? (JSON.parse(line) as Record<string, unknown>) : null))
      .find((frame) => frame?.error !== undefined) as
      | { id?: number; error?: { code?: number; message?: string } }
      | undefined
    expect(errorFrame?.id).toBe(7)
    expect(errorFrame?.error?.code).toBe(-32600)
    const tooLarge = events.find((event) => event.name === 'ipc.line_too_large')
    expect(tooLarge?.source).toBe('ipc')
    expect(tooLarge?.payload.bytes).toBe(Buffer.byteLength(oversized, 'utf8'))
    expect(tooLarge?.payload.max_line_bytes).toBe(DEFAULT_IPC_MAX_LINE_BYTES)
  })

  it('discards an oversized line delivered across chunks until the next newline', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const { events, telemetry } = recordingTelemetry()
    const peer = new RpcPeer(input, output, { telemetry, maxLineBytes: 1024 })
    const head = `{"jsonrpc":"2.0","id":42,"method":"fs.read","params":{"blob":"${'a'.repeat(1200)}`
    const tail = `${'b'.repeat(500)}"}`
    input.write(head)
    const response = peer.requestWithId(1, 'fs.diff', {})
    input.write(`${tail}\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n`)
    await expect(response).resolves.toBe('ok')
    const errorFrame = JSON.parse(
      readOutput(output)
        .split('\n')
        .find((line) => line.includes('-32600'))!,
    ) as { id?: number; error?: { code?: number } }
    expect(errorFrame.id).toBe(42)
    expect(errorFrame.error?.code).toBe(-32600)
    const tooLarge = events.find((event) => event.name === 'ipc.line_too_large')
    expect(tooLarge?.payload.bytes).toBe(
      Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8'),
    )
    expect(tooLarge?.payload.max_line_bytes).toBe(1024)
  })

  it('sends an error notification (no id) when the oversized head has no extractable id', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new RpcPeer(input, output, { maxLineBytes: 64 })
    const response = peer.requestWithId(1, 'fs.diff', {})
    input.write(`{"no_id_field":"${'x'.repeat(200)}"}\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n`)
    await expect(response).resolves.toBe('ok')
    const errorFrame = JSON.parse(
      readOutput(output)
        .split('\n')
        .find((line) => line.includes('-32600'))!,
    ) as { id?: number; error?: { code?: number } }
    expect(errorFrame.id).toBeUndefined()
    expect(errorFrame.error?.code).toBe(-32600)
  })

  it('accepts a valid line just under the default limit', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new RpcPeer(input, output)
    const prefix = '{"jsonrpc":"2.0","id":9,"result":"'
    const suffix = '"}'
    const padding = 'y'.repeat(DEFAULT_IPC_MAX_LINE_BYTES - 1 - prefix.length - suffix.length)
    const line = `${prefix}${padding}${suffix}`
    expect(Buffer.byteLength(line, 'utf8')).toBe(DEFAULT_IPC_MAX_LINE_BYTES - 1)
    const response = peer.requestWithId(9, 'search.query', {})
    input.write(`${line}\n`)
    await expect(response).resolves.toBe(padding)
    expect(readOutput(output)).not.toContain('-32600')
  })
})
