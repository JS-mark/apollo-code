import { PassThrough, Writable } from 'node:stream'

import { EventBus } from '@apollo-code/core'
import { describe, expect, it, vi } from 'vitest'

import { runSlashCommand, type SlashCommand } from './app'
import { PermissionPromptController } from './permission'
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
  isRaw = false
  isTTY = true
  ref() {
    return this
  }
  setRawMode(_enabled: boolean) {
    this.isRaw = _enabled
    return this
  }
  unref() {
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

  it('renders slash command suggestions', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/',
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
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('/help Show slash commands')
    expect(stdout.output).toContain('/context Show context status (not available)')
  })

  it('reports unavailable and unknown slash commands without throwing', async () => {
    const commands: SlashCommand[] = [
      {
        available: false,
        description: 'Show context status',
        name: 'context',
        run: () => {},
      },
    ]

    await expect(runSlashCommand('/context', commands)).resolves.toBe(
      '/context is not available in this build/session',
    )
    await expect(runSlashCommand('/missing', commands)).resolves.toBe(
      'Unknown slash command: /missing',
    )
  })

  it('buffers stream deltas before rendering', async () => {
    const events = new EventBus()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        events,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await events.emit({
      payload: {},
      sessionId: 'session-1',
      type: 'stream.started',
      version: 1,
    })
    await events.emit({
      payload: { chunk: { kind: 'text.delta', text: 'a' } },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await events.emit({
      payload: { chunk: { kind: 'text.delta', text: 'b' } },
      sessionId: 'session-1',
      type: 'stream.delta',
      version: 1,
    })
    await app.waitUntilRenderFlush()
    expect(stdout.output).not.toContain('ab')

    await new Promise((resolve) => setTimeout(resolve, 40))
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('ab')
  })

  it('renders queued permission prompts', async () => {
    const permissions = new PermissionPromptController()
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        permissions,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    void permissions.request({
      attempt: 1,
      id: 'permission-1',
      input: { command: 'touch x' },
      spec: { bash: { command: 'touch x' } },
      toolName: 'Bash',
    })
    void permissions.request({
      attempt: 1,
      id: 'permission-2',
      input: {},
      spec: { fs: { write: ['x'] } },
      toolName: 'Write',
    })
    await app.waitUntilRenderFlush()
    await app.unmount()
    await app.waitUntilExit()

    expect(stdout.output).toContain('Permission required: Bash')
    expect(stdout.output).toContain('1 queued')
  })
})
