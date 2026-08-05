#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
]
export const TIERS = [1, 2, 3]
const CHECKS = ['build', 'native', 'escape', 'signing', 'notarize']
const ENVIRONMENTS = new Set(['native', 'cross', 'qemu', 'real-hardware', 'not-run'])
const STATUSES = new Set(['pass', 'fail', 'not-run'])
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

function requiredChecks(target, tier) {
  const required = ['build', 'native', 'escape']
  if (tier === 3 && target.includes('windows')) required.push('signing')
  if (tier === 3 && target.includes('apple')) required.push('notarize')
  return required
}

function validateCheck(check, path, generatedAt, maxAgeDays, errors) {
  if (!check || typeof check !== 'object' || !STATUSES.has(check.status)) {
    errors.push(`${path}: status must be pass, fail, or not-run`)
    return
  }
  if (check.status === 'not-run') {
    if (!check.reason?.trim()) errors.push(`${path}: not-run requires a reason`)
    if (check.sha || check.timestamp || check.source)
      errors.push(`${path}: not-run cannot carry evidence`)
    return
  }
  if (!SHA.test(check.sha ?? ''))
    errors.push(`${path}: pass/fail requires a 40 or 64 character lowercase evidence SHA`)
  if (!check.source?.trim()) errors.push(`${path}: pass/fail requires an evidence source`)
  const timestamp = Date.parse(check.timestamp)
  if (!Number.isFinite(timestamp)) errors.push(`${path}: pass/fail requires an RFC3339 timestamp`)
  else {
    const age = Date.parse(generatedAt) - timestamp
    if (age < 0) errors.push(`${path}: evidence timestamp is after generatedAt`)
    if (age > maxAgeDays * 86_400_000)
      errors.push(`${path}: evidence is stale (>${maxAgeDays} days)`)
  }
}

export function evaluateEvidence(document) {
  const errors = []
  if (!document || document.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (!document?.release || typeof document.release !== 'string')
    errors.push('release must be a non-empty string')
  if (!Number.isFinite(Date.parse(document?.generatedAt)))
    errors.push('generatedAt must be RFC3339')
  if (!Number.isInteger(document?.maxAgeDays) || document.maxAgeDays < 1)
    errors.push('maxAgeDays must be a positive integer')
  if (!Array.isArray(document?.entries)) errors.push('entries must be an array')

  const entries = new Map()
  for (const [index, entry] of (document?.entries ?? []).entries()) {
    const path = `entries[${index}]`
    if (!TARGETS.includes(entry?.target)) errors.push(`${path}: unsupported target`)
    if (!TIERS.includes(entry?.tier)) errors.push(`${path}: tier must be 1, 2, or 3`)
    if (!ENVIRONMENTS.has(entry?.environment)) errors.push(`${path}: invalid environment`)
    const key = `${entry?.target}|${entry?.tier}`
    if (entries.has(key)) errors.push(`${path}: duplicate ${key}`)
    entries.set(key, entry)
    for (const name of CHECKS)
      validateCheck(
        entry?.checks?.[name],
        `${path}.checks.${name}`,
        document.generatedAt,
        document.maxAgeDays,
        errors,
      )
    if (
      entry?.checks?.native?.status === 'pass' &&
      !['native', 'real-hardware'].includes(entry.environment)
    )
      errors.push(`${path}: native pass conflicts with ${entry.environment} execution`)
    if (entry?.checks?.escape?.status === 'pass' && entry.environment === 'not-run')
      errors.push(`${path}: escape pass conflicts with not-run execution`)
    const extras = Object.keys(entry?.checks ?? {}).filter((name) => !CHECKS.includes(name))
    if (extras.length) errors.push(`${path}.checks: unsupported checks ${extras.join(', ')}`)
  }

  const rows = []
  for (const target of TARGETS) {
    for (const tier of TIERS) {
      const key = `${target}|${tier}`
      const entry = entries.get(key)
      if (!entry) {
        errors.push(`missing ${key}`)
        continue
      }
      const required = requiredChecks(target, tier)
      const passing = required.filter((name) => entry.checks?.[name]?.status === 'pass').length
      const failed = required.some((name) => entry.checks?.[name]?.status === 'fail')
      const allPass = passing === required.length
      const nativeEnvironment =
        entry.environment === 'native' || entry.environment === 'real-hardware'
      const capability = failed
        ? 'None'
        : allPass && nativeEnvironment
          ? 'Full'
          : passing
            ? tier === 1
              ? 'Weak'
              : 'Partial'
            : 'None'
      const hardwareReady =
        !(tier === 3 && target.includes('aarch64-unknown-linux')) ||
        entry.environment === 'real-hardware'
      rows.push({
        ...entry,
        capability,
        passRatio: `${passing}/${required.length}`,
        releaseReady: allPass && nativeEnvironment && hardwareReady,
      })
    }
  }
  if (entries.size !== 24)
    errors.push(`expected exactly 24 unique target/tier entries, received ${entries.size}`)
  return {
    errors: [...new Set(errors)].toSorted(),
    rows,
    releaseReady:
      errors.length === 0 && rows.length === 24 && rows.every((row) => row.releaseReady),
  }
}

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
const evidenceCell = (entry) =>
  CHECKS.map((name) => {
    const check = entry.checks[name]
    if (check.status === 'not-run') return `${name}:not-run`
    return `${name}:${check.status}@${check.sha.slice(0, 12)} ${check.timestamp} ${check.source}`
  }).join('<br>')

export function renderMatrix(document, evaluation = evaluateEvidence(document)) {
  const lines = [
    '# L4 sandbox evidence matrix',
    '',
    `Schema: v${document.schemaVersion} · Release: \`${cell(document.release)}\` · Generated: ${document.generatedAt} · Max age: ${document.maxAgeDays} days`,
    '',
    `Release gate: **${evaluation.releaseReady ? 'PASS' : 'BLOCKED'}**`,
    '',
    '| Target | Tier | Capability | Execution | Pass ratio | Build/native/escape/signing/notarize evidence | Pending / conflict |',
    '| --- | ---: | --- | --- | ---: | --- | --- |',
  ]
  for (const row of evaluation.rows) {
    const reasons = CHECKS.filter((name) => row.checks[name].status !== 'pass').map(
      (name) => `${name}: ${row.checks[name].reason ?? row.checks[name].status}`,
    )
    lines.push(
      `| \`${row.target}\` | ${row.tier} | ${row.capability} | ${row.environment} | ${row.passRatio} | ${evidenceCell(row)} | ${cell(reasons.join('; ') || 'none')} |`,
    )
  }
  lines.push('', '## Gate diagnostics', '')
  lines.push(
    ...(evaluation.errors.length
      ? evaluation.errors.map((error) => `- ${error}`)
      : ['- Input is structurally valid.']),
  )
  if (!evaluation.releaseReady)
    lines.push(
      '- Stable release is blocked. Build or cross/QEMU success never substitutes for native escape, signing, notarization, or real-hardware evidence.',
    )
  lines.push('')
  return lines.join('\n')
}

async function main(argv) {
  const value = (flag) => argv[argv.indexOf(flag) + 1]
  const input = value('--input')
  const output = value('--output')
  if (!input || !output)
    throw new Error(
      'usage: generate-l4-evidence-matrix.mjs --input <json> --output <md> [--check] [--assert-release]',
    )
  const document = JSON.parse(await readFile(input, 'utf8'))
  const evaluation = evaluateEvidence(document)
  const rendered = renderMatrix(document, evaluation)
  if (argv.includes('--check')) {
    const current = await readFile(output, 'utf8').catch(() => '')
    if (current !== rendered) throw new Error(`${output} is stale; regenerate it`)
  } else await writeFile(output, rendered)
  if (evaluation.errors.length)
    throw new Error(`invalid evidence:\n${evaluation.errors.join('\n')}`)
  if (argv.includes('--assert-release') && !evaluation.releaseReady)
    throw new Error('stable release blocked: required native evidence is incomplete')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
