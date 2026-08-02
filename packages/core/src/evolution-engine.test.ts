import { describe, expect, it } from 'vitest'

import { CONTEXT_TUNABLE_DEFAULTS, EvolutionEngine, type EvolutionRecord } from './evolution-engine'

const persistence = () => {
  const records: EvolutionRecord[] = []
  return {
    records,
    async current() {
      return Object.fromEntries(records.map((record) => [record.param, record.after]))
    },
    async append(record: EvolutionRecord) {
      records.push(record)
    },
  }
}
describe('EvolutionEngine', () => {
  it('whitelists context tuning and permanently excludes security boundaries', () => {
    expect(Object.keys(CONTEXT_TUNABLE_DEFAULTS)).toEqual([
      'compaction_threshold',
      'target_ratio',
      'keep_recent',
      'summary_keep_recent',
    ])
    expect(Object.keys(CONTEXT_TUNABLE_DEFAULTS)).not.toEqual(
      expect.arrayContaining(['sandbox', 'permission', 'untrusted', 'hook_priority']),
    )
  })
  it('waits for a 20-event window and limits the adjustment step', async () => {
    const store = persistence(),
      engine = new EvolutionEngine(store)
    for (let index = 0; index < 19; index++)
      expect(await engine.observe({ post_compact_repeat_rate: 1 })).toBeUndefined()
    expect((await engine.observe({ post_compact_repeat_rate: 1 }))?.after).toBe(0.9)
    expect((await engine.propose('compaction_threshold', 100, 'large suggestion', {}))?.after).toBe(
      0.95,
    )
  })
  it('rolls back worsening changes and stops after three', async () => {
    const store = persistence(),
      engine = new EvolutionEngine(store)
    await engine.propose('target_ratio', 0.55, 'test', {})
    for (let index = 0; index < 3; index++)
      await engine.validate('target_ratio', true, { error_rate: 1 })
    expect(store.records.filter((record) => record.action === 'rolled_back')).toHaveLength(3)
    expect(store.records.at(-1)?.action).toBe('stopped')
    expect(await engine.propose('target_ratio', 0.5, 'ignored', {})).toBeUndefined()
  })
  it('returns defaults when disabled', async () => {
    const store = persistence()
    store.records.push({
      namespace: 'context',
      param: 'target_ratio',
      before: 0.6,
      after: 0.5,
      at: '',
      reason: '',
      signal: {},
      action: 'adjusted',
    })
    expect((await new EvolutionEngine(store, { enabled: false }).values()).target_ratio).toBe(0.6)
  })
})
