import { describe, expect, it } from 'vitest'

import {
  CONTEXT_TUNABLE_DEFAULTS,
  EVOLUTION_DEFAULTS,
  EvolutionEngine,
  type EvolutionRecord,
} from './evolution-engine'

const persistence = () => {
  const records: EvolutionRecord[] = []
  return {
    records,
    async current(namespace = 'context') {
      return Object.fromEntries(
        records
          .filter((record) => record.namespace === namespace)
          .map((record) => [record.param, record.after]),
      )
    },
    async append(record: EvolutionRecord) {
      records.push(record)
    },
    async audit() {
      return records
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
  it('supports router, retry, and tool timeout windows with namespace switches', async () => {
    const store = persistence()
    const engine = new EvolutionEngine(store, {
      sampleWindow: 2,
      namespaces: ['retry', 'tool-timeout'],
    })
    expect(await engine.observe('router', { fallback_success_rate: 1 })).toBeUndefined()
    await engine.observe('retry', { retry_success_rate: 1 })
    expect(await engine.observe('retry', { retry_success_rate: 1 })).toMatchObject({
      namespace: 'retry',
      param: 'max_retries',
      before: 2,
      after: 2.2,
    })
    await engine.observe('tool-timeout', { timeout_rate: 1, user_retry_rate: 1 })
    expect(
      await engine.observe('tool-timeout', { timeout_rate: 1, user_retry_rate: 1 }),
    ).toMatchObject({
      namespace: 'tool-timeout',
      param: 'default_timeout_ms',
      after: 66_000,
    })
  })
  it('rejects unknown and security parameters and caps tool timeouts', async () => {
    const engine = new EvolutionEngine(persistence())
    for (const param of ['sandbox', 'permission', 'untrusted', 'hook_priority'])
      expect(await engine.propose('router', param, 1, 'unsafe', {})).toBeUndefined()
    expect(
      await engine.propose('tool-timeout', 'default_timeout_ms', 999_999, 'large', {}),
    ).toMatchObject({ after: 66_000 })
    expect(EVOLUTION_DEFAULTS['tool-timeout'].default_timeout_ms).toBeLessThanOrEqual(300_000)
  })
  it('requires confirmation for cumulative deviation and freezes after rejection', async () => {
    const store = persistence()
    store.records.push({
      namespace: 'router',
      param: 'cooldown_ms',
      before: 60_000,
      after: 78_000,
      at: '',
      reason: '',
      signal: {},
      action: 'adjusted',
    })
    const engine = new EvolutionEngine(store, { confirm: async () => false })
    expect(await engine.propose('router', 'cooldown_ms', 80_000, 'cumulative', {})).toMatchObject({
      action: 'confirmation_rejected',
      after: 60_000,
    })
    expect(await engine.propose('router', 'cooldown_ms', 50_000, 'frozen', {})).toBeUndefined()
  })
})
