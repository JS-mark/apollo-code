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

void test('CI verifies foundation targets without weakening sandbox evidence', async () => {
  const nativeWorkflow = await readFile(new URL('.github/workflows/native.yml', root), 'utf8')
  assert.match(
    nativeWorkflow,
    /taiki-e\/install-action@cargo-deny[\s\S]*cargo deny check licenses bans/,
  )
  assert.doesNotMatch(nativeWorkflow, /EmbarkStudios\/cargo-deny-action/)
  assert.match(
    nativeWorkflow,
    /Run strict doctor against sandbox-capable target artifacts[\s\S]*doctor --strict --json/,
  )
  assert.doesNotMatch(nativeWorkflow, /if: runner\.os != 'Windows'/)

  const escapeWorkflow = await readFile(
    new URL('.github/workflows/sandbox-escape.yml', root),
    'utf8',
  )
  assert.match(
    escapeWorkflow,
    /runner\.os == 'Linux' && matrix\.verification != 'partial-verified'[\s\S]*kernel\.unprivileged_userns_clone=1/,
  )
  assert.match(escapeWorkflow, /name: Record verification evidence\s+shell: bash\s+run:/)

  const windowsTier1 = await readFile(
    new URL('crates/apollo-sandbox/tests/escape/windows-tier1.ps1', root),
    'utf8',
  )
  assert.match(escapeWorkflow, /verification: native-tier1/)
  assert.match(windowsTier1, /tier -ne 'weak'/)
  assert.match(windowsTier1, /SeDebugPrivilege\|SeShutdownPrivilege\|SeTakeOwnershipPrivilege/)
  assert.match(windowsTier1, /grandchild escape/)

  assert.match(nativeWorkflow, /Authenticode self-sign smoke \(non-production\)/)
  assert.match(nativeWorkflow, /timeout-minutes: 5/)
  assert.match(nativeWorkflow, /apt-get install -y osslsigncode/)
  assert.match(nativeWorkflow, /openssl req -x509/)
  assert.match(nativeWorkflow, /osslsigncode sign/)
  assert.match(nativeWorkflow, /osslsigncode verify/)
  assert.doesNotMatch(nativeWorkflow, /certutil|New-SelfSignedCertificate|signtool\.exe/)
  assert.match(nativeWorkflow, /Expected 3 Windows binaries/)
  assert.match(nativeWorkflow, /production_signature=false/)
  assert.match(nativeWorkflow, /macOS notarization credential gate/)
  assert.match(nativeWorkflow, /submission=blocked/)
})
