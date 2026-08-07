#!/usr/bin/env node
import { createHash, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, normalize, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function canonicalPayload(manifest) {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    fixtureOnly: manifest.fixtureOnly,
    channel: manifest.channel,
    version: manifest.version,
    previousVersion: manifest.previousVersion,
    published: manifest.published,
    artifacts: manifest.artifacts,
    rollback: manifest.rollback,
  })
}

export function validateUpdateManifest(manifest) {
  const errors = []
  if (manifest?.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (manifest?.fixtureOnly !== true) errors.push('fixtureOnly must be true')
  if (manifest?.channel !== 'dry-run') errors.push('channel must equal dry-run')
  if (manifest?.published !== false) errors.push('published must be false')
  if (!VERSION.test(manifest?.version ?? '')) errors.push('version must be valid semver')
  if (!VERSION.test(manifest?.previousVersion ?? ''))
    errors.push('previousVersion must be valid semver')
  if (manifest?.version === manifest?.previousVersion)
    errors.push('version and previousVersion must differ')
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0)
    errors.push('artifacts must be a non-empty array')

  const targets = new Set()
  for (const [index, artifact] of (manifest?.artifacts ?? []).entries()) {
    if (!artifact?.target?.trim()) errors.push(`artifacts[${index}].target is required`)
    if (targets.has(artifact?.target)) errors.push(`artifacts[${index}].target is duplicated`)
    targets.add(artifact?.target)
    if (!artifact?.path?.trim() || artifact.path.startsWith('/') || artifact.path.includes('..'))
      errors.push(`artifacts[${index}].path must be a safe relative path`)
    if (!SHA256.test(artifact?.sha256 ?? ''))
      errors.push(`artifacts[${index}].sha256 must be 64 lowercase hex characters`)
  }

  if (manifest?.rollback?.strategy !== 'restore-previous')
    errors.push('rollback.strategy must equal restore-previous')
  if (manifest?.rollback?.targetVersion !== manifest?.previousVersion)
    errors.push('rollback.targetVersion must equal previousVersion')
  if (manifest?.signature?.algorithm !== 'ed25519')
    errors.push('signature.algorithm must equal ed25519')
  if (manifest?.signature?.keyUsage !== 'test-fixture-only')
    errors.push('signature.keyUsage must equal test-fixture-only')
  if (!manifest?.signature?.publicKey?.includes('BEGIN PUBLIC KEY'))
    errors.push('signature.publicKey must be a PEM public key')
  if (!manifest?.signature?.value?.trim()) errors.push('signature.value is required')
  return [...new Set(errors)].toSorted()
}

export async function verifyUpdateManifest(manifest, root) {
  const errors = validateUpdateManifest(manifest)
  if (errors.length) throw new Error(`invalid update manifest:\n${errors.join('\n')}`)

  const base = resolve(root)
  for (const artifact of manifest.artifacts) {
    const path = resolve(base, normalize(artifact.path))
    if (relative(base, path).startsWith('..'))
      throw new Error(`unsafe artifact path: ${artifact.path}`)
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    if (actual !== artifact.sha256) throw new Error(`artifact digest mismatch: ${artifact.target}`)
  }

  const valid = verify(
    null,
    Buffer.from(canonicalPayload(manifest)),
    manifest.signature.publicKey,
    Buffer.from(manifest.signature.value, 'base64'),
  )
  if (!valid) throw new Error('manifest signature verification failed')

  return {
    verified: true,
    dryRun: true,
    rollback: {
      action: 'restore-previous',
      fromVersion: manifest.version,
      toVersion: manifest.previousVersion,
      executed: false,
    },
  }
}

async function main(argv) {
  const inputIndex = argv.indexOf('--input')
  const input = inputIndex === -1 ? undefined : argv[inputIndex + 1]
  if (!input) throw new Error('usage: verify-update-manifest.mjs --input <json>')
  const manifest = JSON.parse(await readFile(input, 'utf8'))
  const result = await verifyUpdateManifest(manifest, dirname(input))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
