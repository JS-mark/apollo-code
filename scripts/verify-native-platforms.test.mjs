import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

void test('publishes all native binaries as versioned GitHub Release assets', async () => {
  const [workflow, bridge, workspace] = await Promise.all([
    readFile(new URL('.github/workflows/native.yml', root), 'utf8'),
    readFile(new URL('packages/native-bridge/package.json', root), 'utf8'),
    readFile(new URL('pnpm-workspace.yaml', root), 'utf8'),
  ])
  assert.match(workflow, /tags: \['v\*'\]/)
  assert.match(workflow, /release-assets\/apollo-\$kind-\$suffix\$extension/)
  assert.match(workflow, /sha256sum apollo-\* > checksums\.sha256/)
  assert.match(workflow, /gh release upload/)
  assert.doesNotMatch(bridge, /optionalDependencies/)
  assert.doesNotMatch(workspace, /platforms\/\*/)
  for (const kind of kinds) assert.match(workflow, new RegExp(`for kind in sandbox search fs`))
  assert.equal(targets.length * kinds.length, 24)
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
  assert.match(
    nativeWorkflow,
    /pnpm turbo run build --filter=apollo-code\.\.\./,
    'native jobs must not start the independent TypeDoc/VitePress build in parallel',
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

  const windowsTier2 = await readFile(
    new URL('crates/apollo-sandbox/tests/escape/windows-tier2.ps1', root),
    'utf8',
  )
  assert.match(escapeWorkflow, /verification: native-tier2/)
  assert.match(windowsTier2, /tier -ne 'partial'/)
  assert.match(windowsTier2, /acl_rollback/)
  assert.match(windowsTier2, /orphan_cleanup/)
  assert.match(windowsTier2, /SeDebugPrivilege\|SeShutdownPrivilege\|SeTakeOwnershipPrivilege/)
  assert.match(windowsTier2, /grandchild escape/)
  assert.match(windowsTier2, /outside the filesystem allowlist/)
  assert.match(windowsTier2, /ACE was not rolled back/)

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
