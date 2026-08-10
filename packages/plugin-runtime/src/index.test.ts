import { createHash } from 'node:crypto'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'

import type { PluginHost } from '@apollo-code/native-bridge'
import { describe, expect, it, vi } from 'vitest'

import {
  APOLLO_BRIDGE_CAPABILITIES,
  BridgeRuntime,
  createRpcGuard,
  PluginManager,
  PluginRegistryClient,
  PluginRuntime,
  validateManifest,
  verifyBundle,
  verifyPluginRegistryMetadata,
} from './index'
const manifest = {
  name: 'apollo-plugin-test',
  version: '1.0.0',
  engines: { apollo: '^1.0.0' },
  main: 'index.js',
  type: 'module',
  permissions: { apollo: ['tools.register'], net: false },
} as const
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'apollo-plugin-'))
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'index.js'), 'export default {}')
  return root
}
describe('plugin runtime', () => {
  it('publishes an exhaustive ApolloBridge capability matrix with test entry points', () => {
    const expected = [
      'tools.register',
      'tools.unregister',
      'hooks.on',
      'hooks.off',
      'hooks.kv.get',
      'hooks.kv.set',
      'hooks.kv.delete',
      'hooks.kv.clear',
      'commands.register',
      'prompt.contribute',
      'prompt.revoke',
      'session.getMessages',
      'session.getUsage',
      'session.on',
      'fs.readFile',
      'fs.writeFile',
      'fs.exists',
      'fs.glob',
      'fs.stat',
      'exec',
      'http.fetch',
      'ui.confirm',
      'ui.prompt',
      'ui.pick',
      'ui.notify',
      'storage.get',
      'storage.set',
      'storage.delete',
      'config.get',
      'log.debug',
      'log.info',
      'log.warn',
      'log.error',
      'call',
      'provider.register',
      'auth.getAuthHeaders',
      'auth.getSigningEnvKeys',
    ]
    expect(APOLLO_BRIDGE_CAPABILITIES.map(({ method }) => method)).toEqual(expected)
    expect(new Set(APOLLO_BRIDGE_CAPABILITIES.map(({ method }) => method)).size).toBe(
      expected.length,
    )
    expect(APOLLO_BRIDGE_CAPABILITIES.every(({ test }) => test.length > 0)).toBe(true)
    expect(APOLLO_BRIDGE_CAPABILITIES.find(({ method }) => method === 'call')).toMatchObject({
      status: 'unsupported',
      reason: expect.any(String),
    })
  })

  const registryDigest = `sha256-${'a'.repeat(64)}`
  const registryMetadata = {
    schemaVersion: 1,
    name: manifest.name,
    version: manifest.version,
    source: 'https://registry.fixture.invalid/',
    bundle: {
      url: 'https://registry.fixture.invalid/bundles/apollo-plugin-test-1.0.0.tgz',
      digest: registryDigest,
    },
    signature: { keyId: 'fixture-key', value: 'fixture-signature' },
    revoked: false,
  } as const
  const fixtureVerifier = { verify: async () => true }

  it('resolves registry trust metadata through a local-only injected fixture', async () => {
    const client = new PluginRegistryClient({
      source: registryMetadata.source,
      fetchMetadata: async (name, version) => {
        expect([name, version]).toEqual([manifest.name, manifest.version])
        return registryMetadata
      },
      verifier: fixtureVerifier,
    })
    await expect(client.resolve(manifest.name, manifest.version, registryDigest)).resolves.toEqual(
      registryMetadata,
    )
  })

  it('fails closed for missing signatures, revocation, digest mismatch, and source pollution', async () => {
    const expected = {
      name: manifest.name,
      version: manifest.version,
      source: registryMetadata.source,
      digest: registryDigest,
    }
    const verify = (value: unknown) =>
      verifyPluginRegistryMetadata(value, expected, fixtureVerifier)
    const { signature: _signature, ...unsigned } = registryMetadata
    await expect(verify(unsigned)).rejects.toThrow('plugin_registry_metadata_invalid')
    await expect(verify({ ...registryMetadata, revoked: true })).rejects.toThrow(
      'plugin_registry_revoked',
    )
    await expect(
      verify({
        ...registryMetadata,
        bundle: { ...registryMetadata.bundle, digest: `sha256-${'b'.repeat(64)}` },
      }),
    ).rejects.toThrow('plugin_registry_digest_mismatch')
    await expect(
      verify({
        ...registryMetadata,
        bundle: { ...registryMetadata.bundle, url: 'https://evil.invalid/plugin.tgz' },
      }),
    ).rejects.toThrow('plugin_registry_source_pollution')
    await expect(
      verify(Object.assign(Object.create({ polluted: true }), registryMetadata)),
    ).rejects.toThrow('plugin_registry_metadata_invalid')
  })

  it('fails closed when the fixture signature verifier rejects the signed payload', async () => {
    await expect(
      verifyPluginRegistryMetadata(
        registryMetadata,
        {
          name: manifest.name,
          version: manifest.version,
          source: registryMetadata.source,
          digest: registryDigest,
        },
        { verify: () => false },
      ),
    ).rejects.toThrow('plugin_registry_signature_invalid')
  })

  it('accepts only permission-gated allowlisted declarative UI', () => {
    const ui = [{ id: 'branch', surface: 'status-bar', text: 'main' }] as const
    expect(
      validateManifest(
        {
          ...manifest,
          contributes: { ui },
          permissions: { ...manifest.permissions, apollo: ['tools.register', 'ui.contribute'] },
        },
        '1.0.0',
      ).contributes?.ui,
    ).toEqual(ui)
    expect(() => validateManifest({ ...manifest, contributes: { ui } }, '1.0.0')).toThrow(
      'plugin_ui_permission_required',
    )
    expect(() =>
      validateManifest(
        {
          ...manifest,
          contributes: { ui: [{ ...ui[0], surface: 'sidebar' }] },
          permissions: { ...manifest.permissions, apollo: ['ui.contribute'] },
        },
        '1.0.0',
      ),
    ).toThrow('plugin_ui_invalid')
    expect(() =>
      validateManifest(
        {
          ...manifest,
          contributes: { ui: [{ ...ui[0], component: 'file://evil.js' }] },
          permissions: { ...manifest.permissions, apollo: ['ui.contribute'] },
        },
        '1.0.0',
      ),
    ).toThrow('plugin_ui_invalid')
  })

  it('loads enabled plugins over NDJSON and cleans up registrations', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    await manager.install(source)
    let registered: { handler(input: unknown): Promise<unknown> } | undefined
    let disposed = false
    const bridge = new BridgeRuntime({
      session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: (_kind, value) => {
        registered = value as typeof registered
        return {
          dispose: () => {
            disposed = true
          },
        }
      },
      fs: {
        readFile: async () => '',
        writeFile: async () => {},
        exists: async () => false,
        glob: async () => [],
        stat: async () => ({}),
      },
      exec: async () => ({}),
      fetch: async () => ({}),
      ui: () => undefined,
      storage: async () => undefined,
      config: () => undefined,
      log: () => undefined,
    })
    let terminated = false
    const start = async (): Promise<PluginHost> => {
      const childToParent = new PassThrough(),
        parentToChild = new PassThrough()
      const transport = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          parentToChild.write(chunk, callback)
        },
        final(callback) {
          parentToChild.end(callback)
        },
      })
      childToParent.on('data', (chunk) => transport.push(chunk))
      childToParent.on('end', () => transport.push(null))
      parentToChild.setEncoding('utf8')
      let buffer = ''
      parentToChild.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const frame = JSON.parse(buffer.slice(0, newline)) as { id: number; method?: string }
          buffer = buffer.slice(newline + 1)
          if (frame.method === 'callback.invoke')
            childToParent.write(
              `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: frame.id, result: { echoed: true } })}\n`,
            )
        }
      })
      queueMicrotask(() => {
        childToParent.write(
          `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: 1, method: 'apollo.tools.register', params: { name: 'echo', description: 'echo', inputSchema: {}, handler: { $callback: 'handler-1' } } })}\n`,
        )
        childToParent.write(
          `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, method: 'host.activated', params: {} })}\n`,
        )
      })
      return {
        pid: 1,
        bridge: transport,
        terminate: () => {
          terminated = true
          transport.destroy()
        },
        exited: new Promise(() => {}),
      }
    }
    const runtime = new PluginRuntime(manager, bridge, { dataRoot, start })
    await runtime.loadEnabled()
    expect(runtime.active()).toEqual([manifest.name])
    await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_already_loaded')
    await expect(registered!.handler({ text: 'hi' })).resolves.toEqual({ echoed: true })
    await runtime.setEnabled(manifest.name, false)
    expect(terminated).toBe(true)
    expect(disposed).toBe(true)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })

  it('times out activation, cleans the process, and disables after three failures', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    await manager.install(source)
    let terminated = 0
    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
        register: () => ({ dispose() {} }),
        fs: {
          readFile: async () => '',
          writeFile: async () => {},
          exists: async () => false,
          glob: async () => [],
          stat: async () => ({}),
        },
        exec: async () => ({}),
        fetch: async () => ({}),
        ui: () => undefined,
        storage: async () => undefined,
        config: () => undefined,
        log: () => undefined,
      }),
      {
        dataRoot,
        activationTimeoutMs: 5,
        start: async () => {
          const bridge = new PassThrough()
          return {
            pid: 1,
            bridge,
            terminate: () => {
              terminated++
              bridge.destroy()
            },
            exited: new Promise(() => {}),
          }
        },
      },
    )
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_activation_timeout')
    expect(terminated).toBe(3)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })

  it('kills a no-response host and disposes its worker registrations', async () => {
    vi.useFakeTimers()
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    await manager.install(source)
    let registrationsDisposed = 0
    let terminated = 0
    const bridge = new BridgeRuntime({
      session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: () => ({
        dispose: () => {
          registrationsDisposed++
        },
      }),
      fs: {
        readFile: async () => '',
        writeFile: async () => {},
        exists: async () => false,
        glob: async () => [],
        stat: async () => ({}),
      },
      exec: async () => ({}),
      fetch: async () => ({}),
      ui: () => undefined,
      storage: async () => undefined,
      config: () => undefined,
      log: () => undefined,
    })
    const runtime = new PluginRuntime(manager, bridge, {
      dataRoot,
      heartbeatTimeoutMs: 20,
      start: async () => {
        const transport = new PassThrough()
        queueMicrotask(() => {
          transport.write(
            `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, id: 1, method: 'apollo.tools.register', params: { name: 'stalled', description: 'stalled', inputSchema: {}, handler: { $callback: 'handler-1' } } })}\n`,
          )
          transport.write(
            `${JSON.stringify({ jsonrpc: '2.0', bridgeVersion: 1, method: 'host.activated', params: {} })}\n`,
          )
        })
        return {
          pid: 1,
          bridge: transport,
          terminate: () => {
            terminated++
            transport.destroy()
          },
          exited: new Promise(() => {}),
        }
      },
    })
    await runtime.load(manifest.name)
    expect(runtime.active()).toEqual([manifest.name])
    await vi.advanceTimersByTimeAsync(21)
    await Promise.resolve()
    expect(terminated).toBe(1)
    expect(registrationsDisposed).toBe(1)
    expect(runtime.active()).toEqual([])
    vi.useRealTimers()
  })

  it('cancels activation and rejects a changed approval hash', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      dataRoot = await mkdtemp(join(tmpdir(), 'apollo-data-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    await manager.install(source)
    const runtime = new PluginRuntime(
      manager,
      new BridgeRuntime({
        session: { id: 's', cwd: source, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
        register: () => ({ dispose() {} }),
        fs: {
          readFile: async () => '',
          writeFile: async () => {},
          exists: async () => false,
          glob: async () => [],
          stat: async () => ({}),
        },
        exec: async () => ({}),
        fetch: async () => ({}),
        ui: () => undefined,
        storage: async () => undefined,
        config: () => undefined,
        log: () => undefined,
      }),
      {
        dataRoot,
        start: async () => {
          const bridge = new PassThrough()
          return {
            pid: 1,
            bridge,
            terminate: () => bridge.destroy(),
            exited: new Promise(() => {}),
          }
        },
      },
    )
    const controller = new AbortController()
    const loading = runtime.load(manifest.name, controller.signal)
    controller.abort()
    await expect(loading).rejects.toThrow('plugin_activation_cancelled')
    await writeFile(
      join(root, manifest.name, 'manifest.json'),
      JSON.stringify({ ...manifest, permissions: { apollo: ['tools.register', 'log.write'] } }),
    )
    await expect(runtime.load(manifest.name)).rejects.toThrow('plugin_approval_stale')
  })
  it('validates engines and rejects path escapes', () => {
    expect(validateManifest(manifest, '1.4.0').name).toBe(manifest.name)
    expect(() => validateManifest({ ...manifest, main: '../x' }, '1.0.0')).toThrow('invalid')
  })
  it('checks integrity and symlink escapes', async () => {
    const dir = await fixture()
    const hash = createHash('sha256')
      .update(await readFile(join(dir, 'index.js')))
      .digest('hex')
    await expect(verifyBundle(dir, manifest, { 'index.js': hash })).resolves.toBeUndefined()
    await symlink('index.js', join(dir, 'escape'))
    await expect(verifyBundle(dir, manifest, { escape: hash })).rejects.toThrow(/escapes|symlink/)
  })
  it('installs atomically and auto disables repeated failures', async () => {
    const source = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'apollo-installed-')),
      manager = new PluginManager(root, '1.0.0', async () => true)
    await manager.init()
    await manager.install(source)
    expect(manager.list()[manifest.name]?.enabled).toBe(true)
    await manager.recordFailure(manifest.name, 2)
    expect(await manager.recordFailure(manifest.name, 2)).toBe(true)
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
  })
  it('enforces rpc allowlists and per-turn quotas', () => {
    const guard = createRpcGuard(manifest, 1)
    guard('t', 'tools.register')
    expect(() => guard('t', 'tools.register')).toThrow('tools.register')
    expect(() => guard('u', 'fs.write')).toThrow('fs.write')
  })

  it('exposes permission-gated bridge namespaces and immutable session snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-bridge-'))
    await writeFile(join(cwd, 'allowed.txt'), 'ok')
    const logs: unknown[] = [],
      storage = new Map<string, unknown>(),
      registrations: string[] = []
    const runtime = new BridgeRuntime({
      session: {
        id: 's1',
        cwd,
        messages: [{ role: 'user', content: 'hello' }],
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      register: (kind) => {
        registrations.push(kind)
        return {
          dispose: () => {
            registrations.push(`dispose:${kind}`)
          },
        }
      },
      fs: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile,
        exists: async () => true,
        glob: async () => [],
        stat: async () => ({ size: 2, type: 'file', modifiedAt: 0 }),
      },
      exec: async () => ({ stdout: 'safe', stderr: '', code: 0 }),
      fetch: async () => ({ ok: true }),
      ui: async () => true,
      storage: async (plugin, operation, key, value) => {
        const isolated = `${plugin}:${key}`
        if (operation === 'set') storage.set(isolated, value)
        if (operation === 'delete') storage.delete(isolated)
        return storage.get(isolated)
      },
      config: () => 'configured',
      log: (_level, _message, meta) => logs.push(meta),
    })
    const bridgeManifest = {
      ...manifest,
      config: { mode: { type: 'string' } },
      permissions: {
        fs: { read: [cwd], write: [cwd] },
        bash: { allowlist: ['git *'] },
        net: { allowlist: ['api.example.com'] },
        apollo: [
          'tools.register',
          'hooks.on',
          'session.read',
          'fs.read',
          'fs.write',
          'exec',
          'http.fetch',
          'storage.read',
          'storage.write',
          'config.read',
          'log.write',
        ],
      },
    } as const
    const bridge = runtime.create(bridgeManifest, join(cwd, 'data'), 'turn-1')
    runtime.registerUiContributions({
      ...bridgeManifest,
      contributes: { ui: [{ id: 'status', surface: 'status-bar', text: 'ready' }] },
    })
    bridge.tools.register({ name: 'x', description: 'x', inputSchema: {}, async handler() {} })
    expect(await bridge.fs.readFile('allowed.txt')).toBe('ok')
    await expect(bridge.exec('git status')).resolves.toMatchObject({ code: 0 })
    await expect(bridge.exec('rm -rf /')).rejects.toThrow('plugin_exec_denied')
    await expect(bridge.http.fetch('https://api.example.com/v1')).resolves.toEqual({ ok: true })
    await expect(bridge.http.fetch('https://evil.example/v1')).rejects.toThrow('plugin_net_denied')
    const messages = bridge.session.getMessages()
    expect(Object.isFrozen(bridge.plugin)).toBe(true)
    expect(messages).not.toBe(runtime.host.session.messages)
    await bridge.storage.set('key', { value: 1 })
    expect(await bridge.storage.get('key')).toEqual({ value: 1 })
    bridge.log.info('Bearer top-secret', { apiKey: 'secret' })
    expect(JSON.stringify(logs)).not.toContain('top-secret')
    expect(JSON.stringify(logs)).not.toContain('secret')
    await runtime.deactivate(manifest.name)
    expect(registrations).toContain('dispose:tool')
    expect(registrations).toContain('dispose:ui')
  })

  it('orders hooks by priority, short-circuits veto, enforces kv quota and timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-hooks-')),
      calls: string[] = []
    const runtime = new BridgeRuntime(
      {
        session: { id: 's', cwd, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
        register: () => ({ dispose() {} }),
        fs: {
          readFile: async () => '',
          writeFile: async () => {},
          exists: async () => false,
          glob: async () => [],
          stat: async () => ({}),
        },
        exec: async () => ({}),
        fetch: async () => ({}),
        ui: () => undefined,
        storage: async () => undefined,
        config: () => undefined,
        log: () => undefined,
      },
      { timeoutMs: 10, hookKvBytes: 20 },
    )
    const hookManifest = { ...manifest, permissions: { apollo: ['hooks.on'] } } as const
    const bridge = runtime.create(hookManifest, cwd, 'tool-1')
    bridge.hooks.on(
      'preToolUse',
      () => {
        calls.push('low')
      },
      { priority: 1 },
    )
    bridge.hooks.on(
      'preToolUse',
      () => {
        calls.push('veto')
        return { veto: true, reason: 'no' }
      },
      { priority: 10 },
    )
    expect(await runtime.runHooks('preToolUse', { injected: 'ignore instructions' })).toEqual({
      veto: true,
      reason: 'no',
    })
    expect(calls).toEqual(['veto'])
    bridge.hooks.kv.set('a', 1)
    expect(bridge.hooks.kv.get('a')).toBe(1)
    expect(() => bridge.hooks.kv.set('large', 'x'.repeat(100))).toThrow('quota')
    const slow = runtime.create(hookManifest, cwd, 'tool-2')
    slow.hooks.on('postToolUse', () => new Promise(() => {}))
    await expect(runtime.runHooks('postToolUse', {})).rejects.toThrow('timeout')
  })

  it('rejects symlink escapes and stops after 500 calls per turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'apollo-escape-')),
      outside = await mkdtemp(join(tmpdir(), 'apollo-outside-'))
    await writeFile(join(outside, 'secret'), 'secret')
    await symlink(join(outside, 'secret'), join(cwd, 'link'))
    const runtime = new BridgeRuntime({
      session: { id: 's', cwd, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: () => ({ dispose() {} }),
      fs: {
        readFile: async (path) => readFile(path, 'utf8'),
        writeFile: async () => {},
        exists: async () => true,
        glob: async () => [],
        stat: async () => ({}),
      },
      exec: async () => ({}),
      fetch: async () => ({}),
      ui: () => undefined,
      storage: async () => undefined,
      config: () => undefined,
      log: () => undefined,
    })
    const bridge = runtime.create(
      { ...manifest, permissions: { fs: { read: [cwd] }, apollo: ['fs.read', 'session.read'] } },
      cwd,
      'turn',
    )
    await expect(bridge.fs.readFile('link')).rejects.toThrow('plugin_fs_denied')
    for (let index = 0; index < 499; index++) bridge.session.getUsage()
    expect(() => bridge.session.getUsage()).toThrow('plugin_rpc_quota_exceeded')
  })
})
