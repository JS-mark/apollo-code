import { PassThrough, Writable } from 'node:stream'

import { render, Text } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import type { WelcomePanelData } from '../../welcome'
import { formatDisplayCwd, getWelcomeLayout, truncateMiddle } from './welcomeLayout'
import { WelcomeScreen } from './WelcomeScreen'
import { buildWelcomeScreenState } from './welcomeStateAdapter'

class Output extends Writable {
  output = ''
  _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void) {
    this.output += chunk.toString()
    done()
  }
}
class Input extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
}

describe('welcome screen', () => {
  it.each([
    [{ columns: 120, rows: 30 }, 'full'],
    [{ columns: 90, rows: 24 }, 'compact'],
    [{ columns: 70, rows: 18 }, 'minimal'],
  ] as const)('selects responsive layout for %o', (size, layout) => {
    expect(getWelcomeLayout(size)).toBe(layout)
  })

  it('middle truncates long cwd while preserving the project name', () => {
    expect(
      formatDisplayCwd('/Users/apollo/work/very/long/project-name', '/Users/apollo', 24),
    ).toMatch(/^~\/work.*roject-name$/)
    expect(truncateMiddle('anthropic/a-very-long-model-name', 18)).toHaveLength(18)
  })

  it.each([
    [{ columns: 120, rows: 30 }, 'full'],
    [{ columns: 90, rows: 24 }, 'compact'],
    [{ columns: 70, rows: 18 }, 'minimal'],
  ] as const)('renders a unified %s first-screen shell', async (terminalSize, layout) => {
    const state = buildWelcomeScreenState({ data: fixture({ status: 'unknown' }) })
    expect(state.provider).toMatchObject({ authLabel: 'unknown', authTone: 'warning' })
    expect(state.provider.label).toContain('not configured')
    const stdout = new Output()
    const stdin = new Input()
    const view = render(
      createElement(WelcomeScreen, {
        state,
        terminalSize,
        commandInput: createElement(Text, {}, 'COMMAND INPUT'),
        bottomStatus: createElement(Text, {}, 'BOTTOM STATUS'),
      }),
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await view.waitUntilRenderFlush()
    view.unmount()
    await view.waitUntilExit()
    expect(stdout.output).toContain(`WELCOME / ${layout.toUpperCase()}`)
    expect(stdout.output).toContain('Apollo Code  v0.0.0-test')
    expect(stdout.output).toContain('Trusted: folder')
    expect(stdout.output).toContain('not configured')
    expect(stdout.output).toContain('COMMAND INPUT')
    expect(stdout.output).toContain('BOTTOM STATUS')
    expect(stdout.output).not.toContain('Auth OK')
  })
})

function fixture(model: WelcomePanelData['model']): WelcomePanelData {
  return {
    version: '0.0.0-test',
    sessionId: 'session-123456',
    cwd: '/repo',
    model,
    sandbox: {
      status: 'available',
      tier: 'full',
      mechanism: 'seatbelt',
      filesystem: 'isolated',
      network: 'available',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults'],
      user: { status: 'disabled' },
      project: { status: 'disabled' },
    },
    mcp: { status: 'disabled' },
    history: { status: 'disabled' },
  }
}
