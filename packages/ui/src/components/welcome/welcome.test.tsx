import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

import { render, Text } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import type { WelcomePanelData } from '../../welcome'
import { formatDisplayCwd, getWelcomeLayout, truncateMiddle } from './welcomeLayout'
import { WelcomeScreen } from './WelcomeScreen'
import { buildWelcomeScreenState } from './welcomeStateAdapter'

class Output extends Writable {
  columns = 120
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

  it('uses the compact logo when a PTY reports zero dimensions', () => {
    expect(getWelcomeLayout({ columns: 0, rows: 0 })).toBe('compact')
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

  it.each([
    [{ columns: 120, rows: 30 }, 'full', 'A P O L L O', '/ ____ \\'],
    [{ columns: 90, rows: 24 }, 'compact', '/\\  APOLLO', '/__\\ CODE'],
    [{ columns: 70, rows: 18 }, 'minimal', 'APOLLO', 'Apollo Code  v0.0.0-test'],
  ] as const)(
    'renders a visible %s brand variant without leaving the first viewport',
    async (terminalSize, _layout, brandText, secondaryText) => {
      const output = stripVTControlCharacters(
        await renderWelcome(terminalSize, fixture({ status: 'unknown' })),
      )
      expect(output).toContain(brandText)
      expect(output).toContain(secondaryText)
    },
  )

  it('keeps the full logo fixed beside long workspace and provider values', async () => {
    const output = stripVTControlCharacters(
      await renderWelcome(
        { columns: 120, rows: 30 },
        fixture({
          status: 'available',
          provider: 'anthropic-enterprise-production',
          model: 'claude-an-extremely-long-model-name-for-layout-regression',
          source: 'explicit',
        }),
        '/Users/apollo/workspaces/a-very-long-enterprise-project-name-that-must-not-crush-branding',
      ),
    )
    const lines = output.replaceAll('┘┌', '┘\n┌').split('\n')
    expect(output).toContain('A P O L L O')
    expect(lines.some((line) => line.includes('.----------.') && line.includes('Workspace'))).toBe(
      true,
    )
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(120)
  })
})

async function renderWelcome(
  terminalSize: { columns: number; rows: number },
  data: WelcomePanelData,
  cwd?: string,
) {
  const stdout = new Output()
  stdout.columns = terminalSize.columns
  const view = render(
    createElement(WelcomeScreen, {
      state: buildWelcomeScreenState({ data: { ...data, cwd: cwd ?? data.cwd } }),
      terminalSize,
      commandInput: createElement(Text, {}, 'COMMAND INPUT'),
      bottomStatus: createElement(Text, {}, 'BOTTOM STATUS'),
    }),
    {
      debug: true,
      interactive: false,
      patchConsole: false,
      stdin: new Input() as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    },
  )
  await view.waitUntilRenderFlush()
  view.unmount()
  await view.waitUntilExit()
  return stdout.output
}

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
