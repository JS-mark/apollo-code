export const CONTEXT_TUNABLE_DEFAULTS = {
  compaction_threshold: 0.85,
  target_ratio: 0.6,
  keep_recent: 20,
  summary_keep_recent: 20,
} as const

export type ContextTunableParam = keyof typeof CONTEXT_TUNABLE_DEFAULTS
export type EvolutionSignal = Record<string, number>
export interface EvolutionRecord {
  namespace: 'context'
  param: ContextTunableParam
  before: number
  after: number
  at: string
  reason: string
  signal: EvolutionSignal
  action: 'adjusted' | 'rolled_back' | 'stopped'
}
export interface EvolutionPersistence {
  current(namespace: 'context'): Promise<Partial<Record<ContextTunableParam, number>>>
  append(record: EvolutionRecord): Promise<void>
}
export interface EvolutionOptions {
  enabled?: boolean
  sampleWindow?: number
  worsenStreakLimit?: number
  now?: () => Date
}

const clamp = (param: ContextTunableParam, before: number, proposed: number): number => {
  const fixedStep = param.endsWith('recent') ? 2 : 0.05
  const delta = Math.max(-fixedStep, Math.min(fixedStep, proposed - before))
  const relative = Math.abs(before * 0.1)
  const limited = Math.abs(delta) > relative ? Math.sign(delta) * relative : delta
  return Number((before + limited).toFixed(4))
}

export class EvolutionEngine {
  readonly #windows = new Map<string, EvolutionSignal[]>()
  readonly #last = new Map<ContextTunableParam, EvolutionRecord>()
  readonly #worsen = new Map<ContextTunableParam, number>()
  readonly #stopped = new Set<ContextTunableParam>()
  readonly #options: Required<EvolutionOptions>
  constructor(
    readonly persistence: EvolutionPersistence,
    options: EvolutionOptions = {},
  ) {
    this.#options = {
      enabled: true,
      sampleWindow: 20,
      worsenStreakLimit: 3,
      now: () => new Date(),
      ...options,
    }
  }
  async values(): Promise<Record<ContextTunableParam, number>> {
    if (!this.#options.enabled) return { ...CONTEXT_TUNABLE_DEFAULTS }
    return { ...CONTEXT_TUNABLE_DEFAULTS, ...(await this.persistence.current('context')) }
  }
  async observe(signal: EvolutionSignal): Promise<EvolutionRecord | undefined> {
    if (!this.#options.enabled) return
    const bucket = this.#windows.get('context') ?? []
    bucket.push(signal)
    this.#windows.set('context', bucket)
    if (bucket.length < this.#options.sampleWindow) return
    this.#windows.set('context', [])
    const aggregate = Object.fromEntries(
      Object.keys(bucket[0] ?? {}).map((key) => [
        key,
        bucket.reduce((sum, item) => sum + (item[key] ?? 0), 0) / bucket.length,
      ]),
    )
    return this.evaluate(aggregate)
  }
  async propose(
    param: ContextTunableParam,
    proposed: number,
    reason: string,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined> {
    if (!this.#options.enabled || this.#stopped.has(param)) return
    const before = (await this.values())[param]
    const record: EvolutionRecord = {
      namespace: 'context',
      param,
      before,
      after: clamp(param, before, proposed),
      at: this.#options.now().toISOString(),
      reason,
      signal,
      action: 'adjusted',
    }
    if (record.after === before) return
    await this.persistence.append(record)
    this.#last.set(param, record)
    return record
  }
  async validate(param: ContextTunableParam, worsened: boolean, signal: EvolutionSignal) {
    const prior = this.#last.get(param)
    if (!prior || !worsened) {
      if (!worsened) this.#worsen.set(param, 0)
      return
    }
    const streak = (this.#worsen.get(param) ?? 0) + 1
    this.#worsen.set(param, streak)
    const rollback: EvolutionRecord = {
      ...prior,
      before: prior.after,
      after: prior.before,
      at: this.#options.now().toISOString(),
      reason: 'validation window worsened; automatic rollback',
      signal,
      action: 'rolled_back',
    }
    await this.persistence.append(rollback)
    if (streak >= this.#options.worsenStreakLimit) {
      this.#stopped.add(param)
      await this.persistence.append({
        ...rollback,
        before: rollback.after,
        action: 'stopped',
        reason: 'three consecutive worsening validations; automatic tuning stopped',
      })
    }
    return rollback
  }
  private async evaluate(signal: EvolutionSignal) {
    if ((signal.post_compact_repeat_rate ?? 0) > 0.2)
      return this.propose(
        'compaction_threshold',
        (await this.values()).compaction_threshold + 0.05,
        'post-compaction repeat rate exceeded 0.2',
        signal,
      )
    if ((signal.context_length_error_rate ?? 0) > 0.1)
      return this.propose(
        'compaction_threshold',
        (await this.values()).compaction_threshold - 0.05,
        'context length error rate exceeded 0.1',
        signal,
      )
    if ((signal.immediate_recompact_rate ?? 0) > 0.2)
      return this.propose(
        'target_ratio',
        (await this.values()).target_ratio - 0.05,
        'immediate recompaction rate exceeded 0.2',
        signal,
      )
    if ((signal.keep_outside_window_rate ?? 0) > 0.2)
      return this.propose(
        'keep_recent',
        (await this.values()).keep_recent + 2,
        'kept messages frequently fell outside the recent window',
        signal,
      )
    if ((signal.summary_recent_loss_rate ?? 0) > 0.2)
      return this.propose(
        'summary_keep_recent',
        (await this.values()).summary_keep_recent + 2,
        'recent context was frequently lost after summary',
        signal,
      )
  }
}
