import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EvolutionStore, TuningMemoryStore } from './evolution-store'

describe('evolution persistence', () => {
  it('writes sanitized append-only namespace and audit records and recovers around corruption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-')),
      store = new EvolutionStore(root)
    await store.append({
      namespace: 'context',
      param: 'target_ratio',
      before: 0.6,
      after: 0.55,
      at: '2026-01-01T00:00:00Z',
      reason: 'Bearer secret',
      signal: { rate: 1 },
      action: 'adjusted',
    })
    await writeFile(join(root, 'context.jsonl'), '{corrupt}\n', { flag: 'a' })
    await store.append({
      namespace: 'context',
      param: 'keep_recent',
      before: 20,
      after: 22,
      at: '2026-01-02T00:00:00Z',
      reason: 'ok',
      signal: {},
      action: 'adjusted',
    })
    expect(await store.current('context')).toEqual({ target_ratio: 0.55, keep_recent: 22 })
    expect(await readFile(join(root, 'audit.jsonl'), 'utf8')).not.toContain('Bearer secret')
    expect((await store.rollback('context')).at(0)).toMatchObject({
      param: 'keep_recent',
      after: 20,
      action: 'rolled_back',
    })
  })
  it('writes tuning-scoped evolution memory with sanitization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-memory-')),
      store = new TuningMemoryStore(root)
    const memory = await store.write({ id: 'one', title: 'preference', body: 'Bearer secret' })
    expect(memory).toMatchObject({ scope: 'tuning', source: 'evolution' })
    expect((await store.read('one')).body).toContain('[REDACTED]')
  })
  it('serializes concurrent appends without losing or interleaving records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-tuning-concurrent-'))
    const store = new EvolutionStore(root)
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.append({
          namespace: 'retry',
          param: 'max_retries',
          before: index,
          after: index + 1,
          at: new Date(index).toISOString(),
          reason: 'concurrent',
          signal: {},
          action: 'adjusted',
        }),
      ),
    )
    expect(await store.audit('retry')).toHaveLength(25)
    expect(await store.current('retry')).toEqual({ max_retries: 25 })
  })
})
