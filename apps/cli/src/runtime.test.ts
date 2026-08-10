import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

  it('returns an interactive handle for the restored session', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const first = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await first.start({ cwd: process.cwd(), prompt: 'before resume' })
    const second = new RuntimeSessionPort(root, fakeFactory())

    const interactive = await second.resumeInteractive(id)
    await interactive.submit('after resume')

    expect(interactive.id).toBe(id)
    expect(await readFile(join(root, `${id}.jsonl`), 'utf8')).toContain('after resume')
  })

  it('keeps the current session active when a resumed runner cannot be constructed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const targetRuntime = new RuntimeSessionPort(root, fakeFactory())
    const target = await targetRuntime.start({ cwd: process.cwd(), prompt: 'target' })
    let creations = 0
    const runtime = new RuntimeSessionPort(root, (state, events) => {
      creations += 1
      if (creations > 1) throw new Error('runner construction failed')
      return fakeFactory()(state, events)
    })
    const current = await runtime.startInteractive({ cwd: process.cwd() })

    await expect(runtime.resumeInteractive(target.id)).rejects.toThrow('runner construction failed')
    await current.submit('still current')

    expect(await readFile(join(root, `${current.id}.jsonl`), 'utf8')).toContain('still current')
    expect(await readFile(join(root, `${target.id}.jsonl`), 'utf8')).not.toContain('still current')
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
  it('exposes one production memory service and reloads its durable state', async () => {
    const root = await mkdtemp(join(process.cwd(), '.memory-composition-'))
    fixtures.push(root)
    const first = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    const memory = first.memory
    expect(memory).toBe(first.memory)
    await memory?.create({
      id: 'composition-root',
      scope: { kind: 'project', workspaceId: 'local', projectId: 'apollo' },
      content: 'production reachable',
      provenance: { source: 'agent' },
    })
    await memory?.flush()

    const restarted = createProductionPorts({
      apolloHome: root,
      identity: { version: '1.2.3-test' },
    })
    expect(
      await restarted.memory?.get(
        { kind: 'project', workspaceId: 'local', projectId: 'apollo' },
        'composition-root',
      ),
    ).toMatchObject({ content: 'production reachable' })
  })

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

describe.skipIf(process.env.APOLLO_RUN_PLUGIN_E2E !== '1')(
  'production plugin composition root (requires a supported native sandbox binary)',
  () => {
    it('routes real host tool and command registrations into production registries', async () => {
      const root = await mkdtemp(join(process.cwd(), '.plugin-composition-'))
      fixtures.push(root)
      const source = join(root, 'source')
      await mkdir(source)
      await writeFile(
        join(source, 'manifest.json'),
        JSON.stringify({
          name: 'apollo-plugin-composition-test',
          version: '1.2.3',
          type: 'module',
          main: 'index.js',
          engines: { apollo: '^1.2.3' },
          permissions: { apollo: ['tools.register', 'commands.register'] },
        }),
      )
      await writeFile(
        join(source, 'index.js'),
        `export async function activate(apollo) {
          await apollo.tools.register({ name: 'plugin:apollo-plugin-composition-test:composition.tool', description: 'test', inputSchema: {}, async handler() { return 'ok' } })
          await apollo.commands.register({ name: 'composition-command', async handler() {} })
        }`,
      )
      const contributions: Array<{ kind: 'tool' | 'command'; name: string; plugin: string }> = []
      const ports = createProductionPorts({
        apolloHome: join(root, 'home'),
        identity: { version: '1.2.3' },
        pluginApproval: async () => true,
        onPluginContribution: (value) => contributions.push(value),
      })
      await ports.plugin?.install(source)
      const session = await ports.session.startInteractive!({ cwd: root })
      expect(contributions).toEqual([
        {
          kind: 'tool',
          name: 'plugin:apollo-plugin-composition-test:composition.tool',
          plugin: 'apollo-plugin-composition-test',
        },
        {
          kind: 'command',
          name: 'composition-command',
          plugin: 'apollo-plugin-composition-test',
        },
      ])
      await session.end()
    })
  },
)
