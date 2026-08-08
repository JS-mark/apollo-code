import { describe, expect, it } from 'vitest'

import {
  buildStatusSections,
  statusPanelFromWelcome,
  validateStatusConfigValue,
  type StatusViewModel,
} from './status'
import type { WelcomePanelData } from './welcome'

describe('status panel adapter', () => {
  it('uses honest unavailable values and never includes credential values', () => {
    const data = statusPanelFromWelcome(welcomeFixture())
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

describe('status view model formatter', () => {
  it('builds stable JSON-safe Status, Settings, and Config sections', () => {
    const view: StatusViewModel = {
      identity: {
        version: '1.2.3',
        sessionId: 'session-1',
        createdAt: '2026-08-09T00:00:00.000Z',
        cwd: '/repo',
        workspace: { status: 'available', value: '/repo' },
        project: { status: 'not_available', reason: { code: 'project_not_available' } },
      },
      model: {
        status: 'available',
        provider: 'anthropic',
        model: 'claude',
        liteModel: { status: 'disabled' },
        reasoningModel: { status: 'not_available', reason: { code: 'reasoning_unknown' } },
        source: 'session',
      },
      runtime: {
        sandbox: { status: 'available', value: { tier: 'full', mechanism: 'sandbox-exec' } },
        filesystem: { status: 'available', value: 'isolated' },
        network: { status: 'blocked', reason: { code: 'network_blocked' } },
        permission: { status: 'available', value: { mode: 'ask', source: 'default' } },
        memory: { status: 'not_available', reason: { code: 'memory_adapter_unavailable' } },
      },
      auth: {
        configured: { status: 'available', value: true },
        method: { status: 'not_available', reason: { code: 'auth_method_unavailable' } },
      },
      settings: [
        { key: 'language', effectiveValue: 'en', source: 'user', readonly: false, locked: false },
        { key: 'model', effectiveValue: 'claude', source: 'flag', readonly: true, locked: true },
      ],
      config: {
        sources: { status: 'available', value: ['default', 'user', 'flag'] },
      },
      capabilities: {
        mcpServers: { status: 'available', value: { count: 1, names: ['local'] } },
        skills: { status: 'not_available', reason: { code: 'skills_adapter_unavailable' } },
        plugins: { status: 'disabled' },
      },
      usage: {
        tokens: { input: 4, output: 6 },
        context: { currentTokens: 10, maxTokens: 100 },
        costUSD: 0.01,
      },
    }

    const sections = buildStatusSections(view)

    expect(sections.map((section) => section.id)).toEqual(['status', 'settings', 'config'])
    expect(sections[1]?.items).toContainEqual({
      key: 'language',
      label: 'language',
      value: 'en',
      source: 'user',
      readonly: false,
      locked: false,
    })
    expect(sections[2]?.items).toContainEqual(
      expect.objectContaining({ key: 'config.sources', value: 'default, user, flag' }),
    )
    expect(JSON.stringify(sections)).not.toContain(String.fromCharCode(27))
    expect(JSON.parse(JSON.stringify(sections))).toEqual(sections)
  })

  it('preserves not_available reason codes without leaking secret-like settings', () => {
    const view = minimalView({
      settings: [
        {
          key: 'authorization_header',
          effectiveValue: 'Bearer secret',
          source: 'env',
          readonly: true,
          locked: true,
        },
      ],
    })

    const output = JSON.stringify(buildStatusSections(view))
    expect(output).toContain('model_source_unreliable')
    expect(output).not.toContain('authorization')
    expect(output).not.toContain('secret')
  })
})

function welcomeFixture(): WelcomePanelData {
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

function minimalView(overrides: Partial<StatusViewModel> = {}): StatusViewModel {
  return {
    identity: {
      version: '0.0.0',
      sessionId: 'session',
      createdAt: '2026-08-09T00:00:00.000Z',
      cwd: '/repo',
      workspace: { status: 'not_available', reason: { code: 'workspace_not_available' } },
      project: { status: 'not_available', reason: { code: 'project_not_available' } },
    },
    model: {
      status: 'not_available',
      reason: { code: 'model_source_unreliable' },
      source: 'derived_unreliable',
    },
    runtime: {
      sandbox: { status: 'not_available', reason: { code: 'sandbox_not_available' } },
      filesystem: { status: 'not_available', reason: { code: 'filesystem_not_available' } },
      network: { status: 'not_available', reason: { code: 'network_not_available' } },
      permission: { status: 'not_available', reason: { code: 'permission_not_available' } },
      memory: { status: 'not_available', reason: { code: 'memory_not_available' } },
    },
    auth: {
      configured: { status: 'available', value: false },
      method: { status: 'not_available', reason: { code: 'auth_method_unavailable' } },
    },
    settings: [],
    config: {
      sources: { status: 'not_available', reason: { code: 'config_sources_unavailable' } },
    },
    capabilities: {
      mcpServers: { status: 'not_available', reason: { code: 'mcp_not_available' } },
      skills: { status: 'not_available', reason: { code: 'skills_not_available' } },
      plugins: { status: 'not_available', reason: { code: 'plugins_not_available' } },
    },
    usage: {
      tokens: { input: 0, output: 0 },
      context: { currentTokens: 0, maxTokens: 0 },
      costUSD: 0,
    },
    ...overrides,
  }
}
