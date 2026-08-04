import { createHash } from 'node:crypto'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createRpcGuard, PluginManager, validateManifest, verifyBundle } from './index'
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
})
