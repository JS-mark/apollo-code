import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRepoFile = (path) => readFile(resolve(root, path), 'utf8')

const requiredPages = [
  'apps/docs/index.md',
  'apps/docs/docs/getting-started/install.md',
  'apps/docs/docs/getting-started/first-run.md',
  'apps/docs/docs/getting-started/5min-tutorial.md',
  'apps/docs/docs/concepts/agent-loop.md',
  'apps/docs/docs/concepts/security-model.md',
  'apps/docs/docs/reference/cli.md',
  'apps/docs/docs/troubleshooting/auth.md',
  'apps/docs/docs/troubleshooting/sandbox.md',
  'apps/docs/docs/troubleshooting/common-errors.md',
]

void test('ships every required L1 documentation page', async () => {
  await Promise.all(requiredPages.map(readRepoFile))
})

void test('keeps the docs site private and buildable', async () => {
  const manifest = JSON.parse(await readRepoFile('apps/docs/package.json'))
  assert.equal(manifest.private, true)
  assert.equal(manifest.scripts.build, 'vitepress build')
})

void test('documents the prompt-injection trust boundary', async () => {
  const security = await readRepoFile('apps/docs/docs/concepts/security-model.md')
  assert.match(security, /Prompt injection threat model/i)
  assert.match(security, /<untrusted source="...">/)
  assert.match(security, /best-effort/i)
})

void test('does not claim blocked release evidence', async () => {
  const dogfood = await readRepoFile('docs/releases/L1-DOGFOOD.md')
  const signoff = await readRepoFile('docs/releases/L1-SIGNOFF.md')
  assert.match(dogfood, /BLOCKED/)
  assert.match(signoff, /PENDING/)
  assert.doesNotMatch(`${dogfood}\n${signoff}`, /ANTHROPIC_API_KEY\s*=/)
})
