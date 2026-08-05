import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export async function createNativeManifest(assetDirectory, outputDirectory, target) {
  const assets = []
  await mkdir(outputDirectory, { recursive: true })
  for (const kind of ['sandbox', 'search', 'fs']) {
    const suffix = target.startsWith('win32-') ? '.exe' : ''
    const file = `apollo-${kind}-${target}${suffix}`
    const source = join(assetDirectory, file)
    await access(source)
    const body = await readFile(source)
    await copyFile(source, join(outputDirectory, file))
    assets.push({ kind, target, file, sha256: createHash('sha256').update(body).digest('hex') })
  }
  const manifest = { schemaVersion: 1, assets }
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const target = process.env.APOLLO_STANDALONE_TARGET
  const assetDirectory = process.env.APOLLO_NATIVE_ASSET_DIR
  if (!target || !assetDirectory)
    throw new Error('APOLLO_STANDALONE_TARGET and APOLLO_NATIVE_ASSET_DIR are required')
  const out = resolve(
    process.env.APOLLO_STANDALONE_OUT ?? join(root, 'apps/cli/dist/standalone', target),
  )
  await createNativeManifest(resolve(assetDirectory), join(out, 'native'), target)
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bun.status !== 0)
    throw new Error('bun is required for standalone builds; pkg is rejected by the RFC')
  const executable = join(out, `apollo${target.startsWith('win32-') ? '.exe' : ''}`)
  const result = spawnSync(
    'bun',
    ['build', '--compile', join(root, 'apps/cli/dist/apollo.js'), '--outfile', executable],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`bun compile failed with status ${result.status}`)
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  await writeFile(join(out, 'checksums.sha256'), `${digest}  ${basename(executable)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
