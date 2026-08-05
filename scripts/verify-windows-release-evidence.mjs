#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const SHA256 = /^[a-f0-9]{64}$/
const ARCHITECTURES = new Set(['x64', 'arm64'])
const OUTCOMES = new Set([
  'valid',
  'unsigned',
  'invalid-chain',
  'timestamp-mismatch',
  'tampered',
  'revoked',
])

export function verifyWindowsReleaseEvidence(document, { production = false } = {}) {
  const errors = []
  if (document?.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (!['fixture', 'self-signed', 'ev'].includes(document?.certificate?.kind))
    errors.push('certificate.kind must be fixture, self-signed, or ev')
  if (!Array.isArray(document?.artifacts) || document.artifacts.length === 0)
    errors.push('artifacts must be a non-empty array')

  const seen = new Set()
  for (const [index, artifact] of (document?.artifacts ?? []).entries()) {
    const path = `artifacts[${index}]`
    if (!artifact?.name?.endsWith('.exe') && !artifact?.name?.endsWith('.msix'))
      errors.push(`${path}.name must be an .exe or .msix`)
    if (!ARCHITECTURES.has(artifact?.architecture)) errors.push(`${path}.architecture is invalid`)
    if (seen.has(artifact?.architecture)) errors.push(`${path}.architecture is duplicated`)
    seen.add(artifact?.architecture)
    if (!SHA256.test(artifact?.unsignedSha256 ?? ''))
      errors.push(`${path}.unsignedSha256 is invalid`)
    if (!SHA256.test(artifact?.signedSha256 ?? '')) errors.push(`${path}.signedSha256 is invalid`)
    if (!SHA256.test(artifact?.sbomSha256 ?? '')) errors.push(`${path}.sbomSha256 is invalid`)
    if (!SHA256.test(artifact?.attestationSha256 ?? ''))
      errors.push(`${path}.attestationSha256 is invalid`)
    if (!OUTCOMES.has(artifact?.verification?.outcome))
      errors.push(`${path}.verification.outcome is invalid`)
    if (artifact?.verification?.outcome !== 'valid')
      errors.push(`${path}: verification failed (${artifact?.verification?.outcome ?? 'missing'})`)
    if (artifact?.verification?.architecture !== artifact?.architecture)
      errors.push(`${path}: verified architecture does not match`)
    if (artifact?.unsignedSha256 === artifact?.signedSha256)
      errors.push(`${path}: sign-after-build did not change the artifact digest`)
    if (artifact?.logsRedacted !== true) errors.push(`${path}: logs must be marked redacted`)
  }
  for (const architecture of ARCHITECTURES)
    if (!seen.has(architecture)) errors.push(`missing ${architecture} artifact`)

  if (document?.approval?.twoPerson !== true) errors.push('two-person approval is required')
  if (!document?.approval?.changeControlId?.trim()) errors.push('change-control id is required')
  if (document?.timestamp?.verified !== true)
    errors.push('RFC 3161 timestamp verification is required')
  if (!document?.timestamp?.url?.startsWith('https://')) errors.push('timestamp URL must use HTTPS')
  if (document?.store?.identityMatches !== true) errors.push('MSIX Store identity must match')
  if (document?.store?.upgradeTested !== true) errors.push('MSIX upgrade must be tested')
  if (document?.store?.uninstallTested !== true) errors.push('MSIX uninstall must be tested')

  if (production) {
    if (document?.certificate?.kind !== 'ev') errors.push('production requires an EV certificate')
    if (document?.certificate?.organizationValidated !== true)
      errors.push('production requires completed organization validation')
    if (!['managed-signing', 'hsm'].includes(document?.certificate?.keyCustody))
      errors.push('production requires managed signing or HSM key custody')
    if (document?.identity?.oidc !== true) errors.push('production requires workload OIDC')
    if (document?.identity?.staticCredential === true)
      errors.push('production forbids static signing credentials')
    if (document?.certificate?.revoked === true) errors.push('certificate is revoked')
  } else if (document?.certificate?.kind === 'ev') {
    errors.push('dry-run evidence cannot claim an EV certificate')
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)].toSorted() }
}

async function main(argv) {
  const inputIndex = argv.indexOf('--input')
  const input = inputIndex >= 0 ? argv[inputIndex + 1] : undefined
  if (!input)
    throw new Error('usage: verify-windows-release-evidence.mjs --input <json> [--production]')
  const document = JSON.parse(await readFile(input, 'utf8'))
  const result = verifyWindowsReleaseEvidence(document, {
    production: argv.includes('--production'),
  })
  if (!result.ok) throw new Error(`Windows release evidence rejected:\n${result.errors.join('\n')}`)
  console.log('Windows release evidence accepted')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
