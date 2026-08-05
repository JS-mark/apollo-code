import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { evaluateEvidence, renderMatrix, TARGETS, TIERS } from './generate-l4-evidence-matrix.mjs'

const sha = 'a'.repeat(40)
const evidence = (status = 'pass') =>
  status === 'not-run'
    ? { status, reason: 'external gate was not authorized' }
    : { status, sha, timestamp: '2026-08-04T00:00:00Z', source: 'artifact://test/evidence' }

function complete() {
  return {
    schemaVersion: 1,
    release: 'v4.0.0-rc.1',
    generatedAt: '2026-08-05T00:00:00Z',
    maxAgeDays: 30,
    entries: TARGETS.flatMap((target) =>
      TIERS.map((tier) => ({
        target,
        tier,
        environment:
          tier === 3 && target.includes('aarch64-unknown-linux') ? 'real-hardware' : 'native',
        checks: {
          build: evidence(),
          native: evidence(),
          escape: evidence(),
          signing: tier === 3 && target.includes('windows') ? evidence() : evidence('not-run'),
          notarize: tier === 3 && target.includes('apple') ? evidence() : evidence('not-run'),
        },
      })),
    ),
  }
}

void test('accepts exactly 8 targets by 3 tiers and renders deterministically', () => {
  const document = complete()
  const evaluation = evaluateEvidence(document)
  assert.deepEqual(evaluation.errors, [])
  assert.equal(evaluation.rows.length, 24)
  assert.equal(evaluation.releaseReady, true)
  assert.equal(
    renderMatrix(document, evaluation),
    renderMatrix(document, evaluateEvidence(structuredClone(document))),
  )
})

void test('fails closed for missing and malformed evidence', () => {
  const document = complete()
  document.entries.pop()
  document.entries[0].checks.escape.sha = 'not-a-sha'
  const evaluation = evaluateEvidence(document)
  assert.equal(evaluation.releaseReady, false)
  assert.match(evaluation.errors.join('\n'), /missing aarch64-pc-windows-msvc\|3/)
  assert.match(evaluation.errors.join('\n'), /evidence SHA/)
})

void test('rejects stale, conflicting, failed, and below-threshold evidence', () => {
  const document = complete()
  document.entries[0].checks.build.timestamp = '2026-01-01T00:00:00Z'
  document.entries[1].environment = 'qemu'
  document.entries[1].checks.native = evidence()
  document.entries[2].checks.escape = evidence('fail')
  const evaluation = evaluateEvidence(document)
  assert.equal(evaluation.releaseReady, false)
  assert.match(evaluation.errors.join('\n'), /stale/)
  assert.match(evaluation.errors.join('\n'), /conflicts with qemu/)
  assert.equal(evaluation.rows[2].passRatio, '3/4')
  assert.equal(evaluation.rows[2].capability, 'None')
})

void test('baseline disclosure is complete but blocks stable release without external gates', async () => {
  const document = JSON.parse(
    await readFile(new URL('../docs/releases/l4-evidence.json', import.meta.url)),
  )
  const evaluation = evaluateEvidence(document)
  assert.deepEqual(evaluation.errors, [])
  assert.equal(evaluation.rows.length, 24)
  assert.equal(evaluation.releaseReady, false)
  assert.ok(
    evaluation.rows.every((row) => row.capability === 'None' && row.passRatio.startsWith('0/')),
  )
  const published = await readFile(
    new URL('../docs/releases/L4-EVIDENCE-MATRIX.md', import.meta.url),
    'utf8',
  )
  assert.equal(published, renderMatrix(document, evaluation))
})
