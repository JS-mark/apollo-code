import { PassThrough, Writable } from 'node:stream'

import { EventBus } from '@apollo-code/core'
import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { runSlashCommand, type SlashCommand } from './app'
import { ModelPicker } from './components/ModelPicker'
import { SelectList } from './components/SelectList'
import { TabBar } from './components/TabBar'
import { PermissionPromptController } from './permission'
import { renderInteractiveApp } from './tui'
import type { WelcomePanelData } from './welcome'

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
  it('renders the welcome panel before the first turn', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        sessionId: 'session-1234567890',
        status: 'ready',
        welcome: welcomeFixture(),
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

    expect(stdout.output).toContain('Apollo Code  v0.0.0-test')
    expect(stdout.output).toContain('Session')
    expect(stdout.output).toContain('session-1234')
    expect(stdout.output).toContain('Model')
    expect(stdout.output).toContain('runtime resolved')
    expect(stdout.output).toContain('MCP')
    expect(stdout.output).toContain('1 connected / 2 configured')
  })

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

  it('advertises /model as available when model picker data exists', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        initialInput: '/',
        modelPicker: modelPickerFixture(),
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

    expect(stdout.output).toContain('/model Switch model')
    expect(stdout.output).not.toContain('/model Switch model (not available)')
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

  it('renders focused list and tab affordances', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const list = render(
      createElement(SelectList, {
        activeId: 'gpt-5',
        items: [
          {
            id: 'default',
            label: 'Default',
            description: 'Use configured default',
          },
          {
            id: 'gpt-5',
            label: 'gpt-5',
            description: 'Current session',
            selected: true,
          },
        ],
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    await list.waitUntilRenderFlush()
    list.unmount()
    await list.waitUntilExit()

    const tabStdout = new MemoryWriteStream()
    const tabs = render(
      createElement(TabBar, {
        activeId: 'status',
        tabs: [
          { id: 'settings', label: 'Settings' },
          { id: 'status', label: 'Status' },
          { id: 'config', label: 'Config' },
        ],
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: tabStdout as unknown as NodeJS.WriteStream,
      },
    )
    await tabs.waitUntilRenderFlush()
    tabs.unmount()
    await tabs.waitUntilExit()

    expect(stdout.output).toContain('> * gpt-5  Current session')
    expect(tabStdout.output).toContain('[Status]')
  })

  it('renders model current and unavailable states', async () => {
    const stdout = new MemoryWriteStream()
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await picker.waitUntilRenderFlush()
    picker.unmount()
    await picker.waitUntilExit()

    expect(stdout.output).toContain('> * Sonnet')
    expect(stdout.output).toContain('Opus  Unavailable')
    expect(stdout.output).toContain('Unavailable models are muted')
  })

  it('supports model picker down and enter interactions', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted: string[] = []
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
        onSubmit: (id) => submitted.push(id),
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\u001B[B')
    await picker.waitUntilRenderFlush()
    stdin.write('\r')
    await picker.waitUntilRenderFlush()
    expect(submitted).toEqual(['openai/gpt-5'])

    picker.unmount()
    await picker.waitUntilExit()
  })

  it('supports model picker escape cancellation', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const cancelled = vi.fn()
    const picker = render(
      createElement(ModelPicker, {
        activeId: 'anthropic/sonnet',
        currentModelId: 'anthropic/sonnet',
        models: modelPickerFixture().models,
        onCancel: cancelled,
      }),
      {
        debug: true,
        interactive: true,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )

    stdin.write('\u001B')
    await new Promise((resolve) => setTimeout(resolve, 40))
    await picker.waitUntilRenderFlush()
    picker.unmount()
    await picker.waitUntilExit()

    expect(cancelled).toHaveBeenCalledOnce()
  })
})

function modelPickerFixture() {
  return {
    currentModelId: 'anthropic/sonnet',
    models: [
      {
        id: 'anthropic/sonnet',
        provider: 'anthropic',
        model: 'sonnet',
        label: 'Sonnet',
        description: 'Current',
      },
      {
        id: 'anthropic/opus',
        provider: 'anthropic',
        model: 'opus',
        label: 'Opus',
        description: 'Unavailable',
        disabled: true,
      },
      {
        id: 'openai/gpt-5',
        provider: 'openai',
        model: 'gpt-5',
        label: 'GPT-5',
        description: 'Available fallback',
      },
    ],
  }
}

function welcomeFixture(): WelcomePanelData {
  return {
    version: '0.0.0-test',
    sessionId: 'session-1234567890',
    cwd: '/repo',
    model: {
      status: 'unknown',
      reason: { code: 'runtime_resolved', message: 'runtime resolved' },
    },
    sandbox: {
      status: 'available',
      tier: 'partial',
      mechanism: 'apollo-sandbox',
      filesystem: 'isolated',
      network: 'unavailable',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults', 'user'],
      user: { status: 'available', path: 'user config', trusted: true },
      project: { status: 'disabled' },
    },
    mcp: {
      status: 'available',
      connected: 1,
      total: 2,
      servers: [
        { name: 'git', status: 'connected' },
        { name: 'docs', status: 'failed' },
      ],
    },
    history: { status: 'available', path: 'history', entries: 0, maxEntries: 1000 },
  }
}
