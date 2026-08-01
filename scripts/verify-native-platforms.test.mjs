import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const kinds = ['sandbox', 'search', 'fs']
const targets = [
  ['darwin-arm64', 'darwin', 'arm64'],
  ['darwin-x64', 'darwin', 'x64'],
  ['linux-arm64-gnu', 'linux', 'arm64', 'glibc'],
  ['linux-x64-gnu', 'linux', 'x64', 'glibc'],
  ['linux-arm64-musl', 'linux', 'arm64', 'musl'],
  ['linux-x64-musl', 'linux', 'x64', 'musl'],
  ['win32-arm64-msvc', 'win32', 'arm64'],
  ['win32-x64-msvc', 'win32', 'x64'],
]

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

void test('publishes exactly 24 auditable native platform manifests', async () => {
  const directories = (await readdir(new URL('platforms/', root))).filter((name) =>
    name.startsWith('native-'),
  )
  assert.equal(directories.length, 24)
  for (const kind of kinds) {
    for (const [target, os, cpu, libc] of targets) {
      const manifest = await json(`platforms/native-${kind}-${target}/package.json`)
      assert.equal(manifest.name, `@apollo-code/native-${kind}-${target}`)
      assert.deepEqual(manifest.os, [os])
      assert.deepEqual(manifest.cpu, [cpu])
      if (libc) assert.deepEqual(manifest.libc, [libc])
      assert.deepEqual(manifest.files, ['bin', 'LICENSE', 'NOTICE'])
      assert.equal(
        manifest.bin[`apollo-${kind}`],
        `bin/apollo-${kind}${os === 'win32' ? '.exe' : ''}`,
      )
    }
  }
})

void test('native bridge declares every platform package optional', async () => {
  const bridge = await json('packages/native-bridge/package.json')
  assert.equal(Object.keys(bridge.optionalDependencies).length, 24)
  for (const kind of kinds)
    for (const [target] of targets)
      assert.equal(
        bridge.optionalDependencies[`@apollo-code/native-${kind}-${target}`],
        'workspace:*',
      )
})
