import { describe, expect, it } from 'vitest'

import {
  applySessionEvent,
  createSessionView,
  renderPrivacyDisclosure,
  renderSandboxDisclosure,
  renderSecurityBanner,
} from './index'

describe('security disclosure', () => {
  it.each([
    [['skip-permissions'], 'DANGER: PERMISSIONS DISABLED'],
    [['no-sandbox'], 'DANGER: NO SANDBOX'],
  ] as const)('renders a persistent red top bar for %j', (modes, text) => {
    const banner = renderSecurityBanner([...modes], true)
    expect(banner).toContain('\u001B[41m')
    expect(banner).toContain(text)
  })

  it('discloses the probed tier and its limitations', () => {
    const output = renderSandboxDisclosure({
      tier: 'partial',
      mechanism: 'landlock v1',
      features: { filesystem: true, network: false },
      degradationReasons: ['seccomp unavailable'],
    })
    expect(output).toContain('Sandbox: PARTIAL')
    expect(output).toContain('seccomp unavailable')
    expect(output).toContain('Network egress: unavailable')
  })

  it('states the local-only telemetry default', () => {
    expect(renderPrivacyDisclosure()).toContain('does not send analytics anywhere by default')
  })
})

describe('session view', () => {
  it('marks interrupted output as withdrawn and records exit', () => {
    const view = createSessionView('session-1')
    applySessionEvent(view, { type: 'stream.delta', text: 'partial' })
    applySessionEvent(view, { type: 'message.interrupted' })
    applySessionEvent(view, { type: 'session.ended' })
    expect(view.transcript).toEqual([])
    expect(view.interruptedText).toBe('partial')
    expect(view.status).toBe('ended')
  })
})
