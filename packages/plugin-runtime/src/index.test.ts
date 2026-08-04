import { createHash } from 'node:crypto'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BridgeRuntime,
  createRpcGuard,
  PluginManager,
  validateManifest,
  verifyBundle,
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
