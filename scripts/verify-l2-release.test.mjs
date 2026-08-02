import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const json = async (path) => JSON.parse(await read(path))

void test('generates TypeDoc markdown inside the private VitePress site', async () => {
  const [rootManifest, docsManifest, typedoc, docsWorkflow] = await Promise.all([
    json('package.json'),
    json('apps/docs/package.json'),
    json('typedoc.json'),
    read('.github/workflows/docs.yml'),
  ])
  assert.equal(docsManifest.private, true)
  assert.match(rootManifest.scripts['docs:api'], /typedoc/)
  assert.match(docsManifest.scripts.build, /docs:api/)
  assert.equal(typedoc.out, 'apps/docs/api')
  assert.deepEqual(typedoc.plugin, ['typedoc-plugin-markdown'])
  assert.match(docsWorkflow, /packages\/\*\/src\/\*\*/)
  assert.match(docsWorkflow, /actions\/deploy-pages@v4/)
})

void test('configures weekly Renovate updates with manual major approval', async () => {
  const renovate = await json('renovate.json')
  assert.deepEqual(renovate.schedule, ['before 6am on monday'])
  const automatic = renovate.packageRules.find((rule) => rule.automerge === true)
  const major = renovate.packageRules.find((rule) => rule.matchUpdateTypes?.includes('major'))
  assert.deepEqual(automatic.matchUpdateTypes, ['minor', 'patch', 'pin', 'digest'])
  assert.equal(major.automerge, false)
  assert.equal(major.dependencyDashboardApproval, true)
})

void test('keeps the 24 native manifests publishable and docs excluded', async () => {
  const directories = (await readdir(new URL('platforms/', root))).filter((name) =>
    name.startsWith('native-'),
  )
  assert.equal(directories.length, 24)
  for (const directory of directories) {
    const manifest = await json(`platforms/${directory}/package.json`)
    assert.notEqual(manifest.private, true, `${manifest.name} must remain publishable`)
  }
  const changesets = await json('.changeset/config.json')
  assert.ok(changesets.ignore.includes('@apollo-code/docs'))
})

void test('release automation versions through Changesets without bypassing external gates', async () => {
  const [workflow, checklist] = await Promise.all([
    read('.github/workflows/release.yml'),
    read('docs/releases/L2-RELEASE-CHECKLIST.md'),
  ])
  assert.match(workflow, /pnpm release:version:dry-run/)
  assert.match(workflow, /changesets\/action@v1/)
  assert.doesNotMatch(workflow, /publish: pnpm release/)
  assert.match(checklist, /24\/24/)
  assert.match(checklist, /0\/2 real hardware/)
  assert.match(checklist, /Production Authenticode.*BLOCKED/i)
  assert.match(checklist, /Apple notarization.*BLOCKED/i)
  assert.doesNotMatch(checklist, /Production Authenticode[^\n]*PASS/i)
})
