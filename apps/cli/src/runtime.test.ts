import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { createSession, updateSession } from '@apollo-code/core'
import type { EventBus, Runner, SessionState } from '@apollo-code/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildStatusViewModel,
  createProductionPorts,
  createStatusSnapshotAdapter,
  FileInputHistoryStore,
  RuntimeSessionPort,
} from './runtime'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

function fakeFactory(
  observe: (state: SessionState, events: EventBus) => void = () => {},
): (state: SessionState, events: EventBus) => Runner {
  return (initial, events) => {
    let state = initial
    const fake = {
      get state() {
        return state
      },
      events,
      interrupt: vi.fn(() => {
        state = updateSession(state, (draft) => {
          draft.pendingInterrupt = true
        })
      }),
      run: vi.fn(async (text: string) => {
        state = updateSession(state, (draft) => {
          draft.messages = [
            ...draft.messages,
            { id: 'user-1', role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
          ]
          draft.turns = [
            ...draft.turns,
            { id: 'turn-1', startMessageId: 'user-1', status: 'streaming', parentDepth: 0 },
          ]
          draft.activeTurn = 'turn-1'
        })
        return state
      }),
    } as unknown as Runner
    observe(state, events)
    return fake
  }
}

describe('RuntimeSessionPort', () => {
  it('runs through a real session port and persists append-only snapshots', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const runtime = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await runtime.start({ cwd: process.cwd(), prompt: 'hello' })
    const lines = (await readFile(join(root, `${id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: any })
    expect(lines.map((line) => line.type)).toContain('session.started')
    expect(lines.at(-1)?.type).toBe('session.snapshot')
    expect(lines.at(-1)?.payload.messages[0].content[0].text).toBe('hello')
  })

  it('resumes the last snapshot, aborts an incomplete turn, and emits session.resumed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const first = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await first.start({ cwd: process.cwd(), prompt: 'unfinished' })
    let restored: SessionState | undefined
    const second = new RuntimeSessionPort(
      root,
      fakeFactory((state) => {
        restored = state
      }),
    )
    await second.resume(id)
    expect(restored?.activeTurn).toBeNull()
    expect(restored?.turns[0]?.status).toBe('aborted')
    expect(await readFile(join(root, `${id}.jsonl`), 'utf8')).toContain('session.resumed')
  })
})

describe('buildStatusViewModel', () => {
  it('aggregates complete confirmed session and runtime data', () => {
    const state = updateSession(
      createSession({
        id: 'session-1',
        cwd: '/repo',
        maxTokens: 200_000,
        toolRegistrySnapshot: 'x',
      }),
      (draft) => {
        draft.createdAt = Date.parse('2026-08-09T00:00:00.000Z')
        draft.cumulativeUsage = { input: 12, output: 8, cacheRead: 2, costUSD: 0.25 }
        draft.contextBudget = { currentTokens: 20, maxTokens: 200_000 }
      },
    )

    const view = buildStatusViewModel({
      state,
      version: '1.2.3',
      workspace: '/workspace',
      project: 'apollo-code',
      model: {
        provider: 'anthropic',
        model: 'claude',
        liteModel: 'haiku',
        reasoningModel: null,
        source: 'router',
      },
      sandbox: {
        tier: 'full',
        mechanism: 'sandbox-exec',
        features: { filesystem: true, network: false },
        degradationReasons: [],
      },
      dangerousPermissions: false,
      authConfigured: true,
      authMethod: 'keychain',
      memoryMode: 'auto',
      settings: [
        {
          key: 'language',
          effectiveValue: 'zh-CN',
          source: 'user',
          readonly: false,
          locked: false,
        },
      ],
      configSources: ['default', 'user'],
      mcpServers: ['local'],
      skills: ['review'],
      plugins: ['git'],
    })

    expect(view.identity).toMatchObject({
      version: '1.2.3',
      sessionId: 'session-1',
      cwd: '/repo',
      createdAt: '2026-08-09T00:00:00.000Z',
    })
    expect(view.model).toEqual({
      status: 'available',
      provider: 'anthropic',
      model: 'claude',
      liteModel: { status: 'available', value: 'haiku' },
      reasoningModel: { status: 'disabled' },
      source: 'router',
    })
    expect(view.runtime).toMatchObject({
      filesystem: { status: 'available', value: 'isolated' },
      network: { status: 'blocked', reason: { code: 'sandbox_network_blocked' } },
      permission: { status: 'available', value: { mode: 'ask', source: 'default' } },
    })
    expect(view.auth).toEqual({
      configured: { status: 'available', value: true },
      method: { status: 'available', value: 'keychain' },
    })
    expect(view.capabilities.mcpServers).toEqual({
      status: 'available',
      value: { count: 1, names: ['local'] },
    })
    expect(view.capabilities.skills).toEqual({
      status: 'available',
      value: { count: 1, names: ['review'] },
    })
    expect(view.capabilities.plugins).toEqual({
      status: 'available',
      value: { count: 1, names: ['git'] },
    })
    expect(view.usage).toMatchObject({
      tokens: { input: 12, output: 8, cacheRead: 2 },
      context: { currentTokens: 20, maxTokens: 200_000 },
      costUSD: 0.25,
    })
  })

  it('never promotes a welcome default into a confirmed current model', () => {
    const state = createSession({
      id: 'session-model',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })
    expect(buildStatusViewModel({ state, version: '0.0.0' }).model).toEqual({
      status: 'not_available',
      source: 'derived_unreliable',
      reason: { code: 'current_model_source_unavailable' },
    })
  })

  it('uses explicit missing states and removes secret-like settings and values', () => {
    const state = createSession({
      id: 'session-secret',
      cwd: '/repo?token=top-secret',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })
    const view = buildStatusViewModel({
      state,
      version: '0.0.0',
      settings: [
        {
          key: 'authorization_header',
          effectiveValue: 'Bearer top-secret',
          source: 'env',
          readonly: true,
          locked: true,
        },
        {
          key: 'endpoint',
          effectiveValue: 'https://user:password@example.test?token=top-secret',
          source: 'user',
          readonly: true,
          locked: false,
        },
      ],
    })

    const serialized = JSON.stringify(view)
    expect(view.auth.configured).toEqual({
      status: 'not_available',
      reason: { code: 'auth_configured_adapter_unavailable' },
    })
    expect(view.identity.workspace).toEqual({
      status: 'not_available',
      reason: { code: 'workspace_adapter_unavailable' },
    })
    expect(view.identity.cwd).toBe('/repo?token=[REDACTED]')
    expect(view.identity.workspace).not.toEqual({ status: 'available', value: view.identity.cwd })
    expect(view.config.sources).toMatchObject({ status: 'not_available' })
    expect(view.runtime.memory).toMatchObject({ status: 'not_available' })
    expect(view.capabilities.skills).toMatchObject({ status: 'not_available' })
    expect(view.capabilities.plugins).toMatchObject({ status: 'not_available' })
    expect(view.settings.map((setting) => setting.key)).toEqual(['endpoint'])
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('authorization_header')
  })

  it('does not call credential-returning APIs while building a production status snapshot', async () => {
    const getCredential = vi.fn(async () => 'must-not-be-read')
    const credentialApi = { getCredential }
    const adapter = createStatusSnapshotAdapter({
      ...credentialApi,
      version: '0.0.0',
      dangerousPermissions: () => false,
      sandbox: async () => undefined,
      configAvailable: async () => false,
    })
    const state = createSession({
      id: 'session-auth',
      cwd: '/repo',
      maxTokens: 100,
      toolRegistrySnapshot: 'x',
    })

    const view = await adapter(state)

    expect(getCredential).not.toHaveBeenCalled()
    expect(view.auth).toEqual({
      configured: {
        status: 'not_available',
        reason: { code: 'auth_configured_adapter_unavailable' },
      },
      method: { status: 'not_available', reason: { code: 'auth_method_adapter_unavailable' } },
    })
  })
})

describe('FileInputHistoryStore', () => {
  it('persists only safe bounded inputs and trims old entries', async () => {
    const root = await mkdtemp(join(process.cwd(), '.history-'))
    fixtures.push(root)
    const path = join(root, 'history', 'input.jsonl')
    const history = new FileInputHistoryStore(path, 1024, 3, 20)

    await history.append('')
    await history.append('hello')
    await history.append('token=secret-value')
    await history.append('x'.repeat(21))
    await history.append('one')
    await history.append('two')
    await history.append('three')

    expect(await history.list()).toEqual(['one', 'two', 'three'])
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('secret-value')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('status configuration adapter', () => {
  it('persists whitelisted preferences atomically and rejects readonly state', async () => {
    const root = await mkdtemp(join(process.cwd(), '.status-'))
    fixtures.push(root)
    const ports = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const input = { cwd: process.cwd(), sessionId: 'session-test' }
    const updated = await ports.config.updatePreference?.('notifications', true, input)
    expect(updated?.config.find((item) => item.id === 'notifications')?.value).toBe(true)
    expect(await readFile(join(root, 'config.toml'), 'utf8')).toContain('notifications = true')
    await expect(ports.config.updatePreference?.('authMethod', 'env', input)).rejects.toThrow(
      'read-only',
    )
    expect(JSON.stringify(updated)).not.toContain('sk-secret-value')
  })
})
