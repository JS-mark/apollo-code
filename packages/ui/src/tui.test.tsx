import { PassThrough, Writable } from 'node:stream'

import { EventBus } from '@apollo-code/core'
import { describe, expect, it } from 'vitest'

import { renderInteractiveApp } from './tui'

class MemoryWriteStream extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  output = ''

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.output += chunk.toString()
    callback()
  }
}

class MemoryReadStream extends PassThrough {
  isTTY = false
  setRawMode(_enabled: boolean) {
    return this
  }
}

describe('renderInteractiveApp', () => {
  it('renders the static Ink shell and stream updates', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
        initialInput: 'hello',
        sessionId: 'session-1234567890',
        status: 'ready',
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await app.waitUntilRenderFlush()

    await events.emit({
      payload: {},
      sessionId: 'session-1234567890',
      type: 'stream.started',
      version: 1,
    })
    await events.emit({
      payload: { chunk: { kind: 'text.delta', text: 'pong' } },
      sessionId: 'session-1234567890',
      type: 'stream.delta',
      version: 1,
    })
    await events.emit({
      payload: {},
      sessionId: 'session-1234567890',
      type: 'stream.completed',
      version: 1,
    })
    await app.waitUntilRenderFlush()

    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('Apollo')
    expect(stdout.output).toContain('/repo')
    expect(stdout.output).toContain('> hello')
    expect(stdout.output).toContain('pong')
  })
})
