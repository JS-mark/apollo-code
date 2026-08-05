import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNativeManifest } from './build-standalone.mjs'

void test('creates a complete, stable native asset manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo manifest '))
  const source = join(root, 'input')
  const output = join(root, 'output')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(source)
  for (const kind of ['sandbox', 'search', 'fs'])
    await writeFile(join(source, `apollo-${kind}-darwin-arm64`), kind)
  try {
    const manifest = await createNativeManifest(source, output, 'darwin-arm64')
    assert.equal(manifest.schemaVersion, 1)
    assert.deepEqual(
      manifest.assets.map((asset) => asset.kind),
      ['sandbox', 'search', 'fs'],
    )
    assert.equal(manifest.assets[0].sha256, createHash('sha256').update('sandbox').digest('hex'))
    assert.deepEqual(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')), manifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
