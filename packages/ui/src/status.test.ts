import { describe, expect, it } from 'vitest'

import { statusPanelFromWelcome, validateStatusConfigValue } from './status'
import type { WelcomePanelData } from './welcome'

describe('status view model', () => {
  it('uses honest unavailable values and never includes credential values', () => {
    const data = statusPanelFromWelcome(fixture())
    expect(data.status).toEqual(
      expect.arrayContaining([
        { label: 'Auth method', value: 'not available' },
        { label: 'Skills', value: 'not available' },
        { label: 'Plugins', value: 'not available' },
      ]),
    )
    expect(JSON.stringify(data)).not.toMatch(/sk-secret|token-value/)
  })

  it('rejects readonly, invalid enum, and out-of-range edits', () => {
    expect(() =>
      validateStatusConfigValue(
        { id: 'authMethod', label: 'Auth method', value: 'keychain', editable: false },
        'env',
      ),
    ).toThrow('read-only')
    expect(() =>
      validateStatusConfigValue(
        {
          id: 'reasoningEffort',
          label: 'Reasoning',
          value: 'low',
          editable: true,
          kind: 'enum',
          choices: ['low', 'high'],
        },
        'extreme',
      ),
    ).toThrow('Allowed values')
    expect(() =>
      validateStatusConfigValue(
        {
          id: 'cleanupPeriod',
          label: 'Cleanup',
          value: 30,
          editable: true,
          kind: 'number',
          min: 1,
          max: 365,
        },
        0,
      ),
    ).toThrow('Minimum')
  })
})

function fixture(): WelcomePanelData {
  return {
    version: '1.2.3',
    sessionId: 'session',
    cwd: '/repo',
    model: { status: 'available', provider: 'anthropic', model: 'sonnet', source: 'default' },
    sandbox: {
      status: 'available',
      tier: 'full',
      mechanism: 'test',
      filesystem: 'workspace',
      network: 'restricted',
    },
    permission: { mode: 'ask', dangerous: false, source: 'default' },
    config: {
      effectiveSources: ['defaults'],
      user: { status: 'disabled' },
      project: { status: 'disabled' },
    },
    mcp: { status: 'unavailable', reason: { code: 'missing', message: 'missing' } },
    history: { status: 'disabled' },
  }
}
