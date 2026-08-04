export const EVOLUTION_DEFAULTS = {
  context: {
    compaction_threshold: 0.85,
    target_ratio: 0.6,
    keep_recent: 20,
    summary_keep_recent: 20,
  },
  router: { cooldown_ms: 60_000, max_attempts: 6 },
  retry: { max_retries: 2, backoff_factor: 4 },
  'tool-timeout': { default_timeout_ms: 60_000 },
} as const

export const CONTEXT_TUNABLE_DEFAULTS = EVOLUTION_DEFAULTS.context
export type EvolutionNamespace = keyof typeof EVOLUTION_DEFAULTS
export type ContextTunableParam = keyof typeof CONTEXT_TUNABLE_DEFAULTS
export type EvolutionParam = string
export type EvolutionSignal = Record<string, number>
export type EvolutionAction = 'adjusted' | 'rolled_back' | 'stopped' | 'confirmation_rejected'
export interface EvolutionRecord {
  namespace: EvolutionNamespace
  param: EvolutionParam
  before: number
  after: number
  at: string
  reason: string
  signal: EvolutionSignal
  action: EvolutionAction
}
export interface EvolutionPersistence {
  current(namespace: EvolutionNamespace): Promise<Partial<Record<string, number>>>
  append(record: EvolutionRecord): Promise<void>
  audit?(namespace?: EvolutionNamespace): Promise<EvolutionRecord[]>
}
export interface EvolutionConfirmation {
  namespace: EvolutionNamespace
  param: string
  before: number
  proposed: number
  defaultValue: number
  deviationPct: number
  reason: string
}
export interface EvolutionOptions {
  enabled?: boolean
  namespaces?: readonly EvolutionNamespace[]
  sampleWindow?: number
  worsenStreakLimit?: number
  confirmationDeviation?: number
  confirm?: (request: EvolutionConfirmation) => Promise<boolean>
  toolTimeoutDefaults?: Readonly<Record<string, number>>
  now?: () => Date
}

const STATIC_PARAMS: Readonly<Record<EvolutionNamespace, ReadonlySet<string>>> = {
  context: new Set(Object.keys(EVOLUTION_DEFAULTS.context)),
  router: new Set(Object.keys(EVOLUTION_DEFAULTS.router)),
  retry: new Set(Object.keys(EVOLUTION_DEFAULTS.retry)),
  'tool-timeout': new Set(['default_timeout_ms']),
}
const allowed = (namespace: EvolutionNamespace, param: string) =>
  STATIC_PARAMS[namespace].has(param) ||
  (namespace === 'tool-timeout' && /^tool:[a-zA-Z0-9_.:-]+:timeout_ms$/.test(param))

const fixedStep = (namespace: EvolutionNamespace, param: string) => {
  if (namespace === 'tool-timeout') return 10_000
  if (namespace === 'retry' && param === 'max_retries') return 1
  if (namespace === 'router' && param === 'max_attempts') return 1
  if (param.endsWith('recent')) return 2
  if (param.includes('threshold') || param.includes('ratio')) return 0.05
  return Number.POSITIVE_INFINITY
}
const clamp = (namespace: EvolutionNamespace, param: string, before: number, proposed: number) => {
  const max = Math.min(fixedStep(namespace, param), Math.abs(before * 0.1))
  const delta = Math.max(-max, Math.min(max, proposed - before))
  const value = Number((before + delta).toFixed(4))
  return namespace === 'tool-timeout' ? Math.min(300_000, Math.max(1_000, value)) : value
}

export class EvolutionEngine {
  readonly #windows = new Map<EvolutionNamespace, EvolutionSignal[]>()
  readonly #last = new Map<string, EvolutionRecord>()
  readonly #worsen = new Map<string, number>()
  readonly #stopped = new Set<string>()
  readonly #options: Required<Omit<EvolutionOptions, 'toolTimeoutDefaults'>> & {
    toolTimeoutDefaults: Readonly<Record<string, number>>
  }
  #restored = false
  constructor(
    readonly persistence: EvolutionPersistence,
    options: EvolutionOptions = {},
  ) {
    this.#options = {
      enabled: true,
      namespaces: ['context', 'router', 'retry', 'tool-timeout'],
      sampleWindow: 20,
      worsenStreakLimit: 3,
      confirmationDeviation: 0.25,
      confirm: async () => false,
      toolTimeoutDefaults: {},
      now: () => new Date(),
      ...options,
    }
  }
  isEnabled(namespace: EvolutionNamespace) {
    return this.#options.enabled && this.#options.namespaces.includes(namespace)
  }
  async values(): Promise<Record<ContextTunableParam, number>>
  async values(namespace: EvolutionNamespace): Promise<Record<string, number>>
  async values(namespace: EvolutionNamespace = 'context'): Promise<Record<string, number>> {
    const defaults = this.#defaults(namespace)
    if (!this.isEnabled(namespace)) return defaults
    const persisted = Object.fromEntries(
      Object.entries(await this.persistence.current(namespace)).filter(
        (entry): entry is [string, number] => entry[1] !== undefined,
      ),
    )
    return { ...defaults, ...persisted }
  }
  async observe(
    namespace: EvolutionNamespace,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async observe(signal: EvolutionSignal): Promise<EvolutionRecord | undefined>
  async observe(first: EvolutionNamespace | EvolutionSignal, second?: EvolutionSignal) {
    const namespace = typeof first === 'string' ? first : 'context'
    const signal = typeof first === 'string' ? second! : first
    if (!this.isEnabled(namespace)) return
    const bucket = this.#windows.get(namespace) ?? []
    bucket.push(signal)
    this.#windows.set(namespace, bucket)
    if (bucket.length < this.#options.sampleWindow) return
    this.#windows.set(namespace, [])
    const aggregate = Object.fromEntries(
      [...new Set(bucket.flatMap(Object.keys))].map((key) => [
        key,
        bucket.reduce((sum, item) => sum + (item[key] ?? 0), 0) / bucket.length,
      ]),
    )
    return this.#evaluate(namespace, aggregate)
  }
  async propose(
    namespace: EvolutionNamespace,
    param: string,
    proposed: number,
    reason: string,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async propose(
    param: ContextTunableParam,
    proposed: number,
    reason: string,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async propose(
    first: EvolutionNamespace | ContextTunableParam,
    second: string | number,
    third: number | string,
    fourth: string | EvolutionSignal,
    fifth?: EvolutionSignal,
  ) {
    const namespace: EvolutionNamespace =
      first in EVOLUTION_DEFAULTS ? (first as EvolutionNamespace) : 'context'
    const param = namespace === first ? String(second) : String(first)
    const proposed = Number(namespace === first ? third : second)
    const reason = String(namespace === first ? fourth : third)
    const signal = (namespace === first ? fifth : fourth) as EvolutionSignal
    if (!this.isEnabled(namespace) || !allowed(namespace, param)) return
    await this.#restore()
    const key = `${namespace}:${param}`
    if (this.#stopped.has(key)) return
    const defaults = this.#defaults(namespace)
    const defaultValue = defaults[param]
    if (defaultValue === undefined) return
    const before = (await this.values(namespace))[param] ?? defaultValue
    const after = clamp(namespace, param, before, proposed)
    if (after === before) return
    const deviationPct =
      defaultValue === 0 ? 0 : Math.abs(after - defaultValue) / Math.abs(defaultValue)
    if (deviationPct > this.#options.confirmationDeviation) {
      const accepted = await this.#options.confirm({
        namespace,
        param,
        before,
        proposed: after,
        defaultValue,
        deviationPct,
        reason,
      })
      if (!accepted) {
        const rejected = this.#record(
          namespace,
          param,
          before,
          defaultValue,
          `${reason}; cumulative deviation rejected; parameter restored and frozen`,
          signal,
          'confirmation_rejected',
        )
        await this.persistence.append(rejected)
        this.#stopped.add(key)
        return rejected
      }
    }
    const record = this.#record(namespace, param, before, after, reason, signal, 'adjusted')
    await this.persistence.append(record)
    this.#last.set(key, record)
    return record
  }
  async validate(
    namespace: EvolutionNamespace,
    param: string,
    worsened: boolean,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async validate(
    param: ContextTunableParam,
    worsened: boolean,
    signal: EvolutionSignal,
  ): Promise<EvolutionRecord | undefined>
  async validate(
    first: EvolutionNamespace | ContextTunableParam,
    second: string | boolean,
    third: boolean | EvolutionSignal,
    fourth?: EvolutionSignal,
  ) {
    const namespace: EvolutionNamespace =
      first in EVOLUTION_DEFAULTS ? (first as EvolutionNamespace) : 'context'
    const param = namespace === first ? String(second) : String(first)
    const worsened = Boolean(namespace === first ? third : second)
    const signal = (namespace === first ? fourth : third) as EvolutionSignal
    await this.#restore()
    const key = `${namespace}:${param}`
    const prior = this.#last.get(key)
    if (!prior || !worsened) {
      if (!worsened) this.#worsen.set(key, 0)
      return
    }
    const streak = (this.#worsen.get(key) ?? 0) + 1
    this.#worsen.set(key, streak)
    const rollback = this.#record(
      namespace,
      param,
      prior.after,
      prior.before,
      'validation window worsened; automatic rollback',
      signal,
      'rolled_back',
    )
    await this.persistence.append(rollback)
    if (streak >= this.#options.worsenStreakLimit) {
      this.#stopped.add(key)
      await this.persistence.append(
        this.#record(
          namespace,
          param,
          rollback.after,
          rollback.after,
          'three consecutive worsening validations; automatic tuning stopped',
          signal,
          'stopped',
        ),
      )
    }
    return rollback
  }
  #defaults(namespace: EvolutionNamespace): Record<string, number> {
    return namespace === 'tool-timeout'
      ? {
          ...EVOLUTION_DEFAULTS['tool-timeout'],
          ...Object.fromEntries(
            Object.entries(this.#options.toolTimeoutDefaults).map(([name, value]) => [
              `tool:${name}:timeout_ms`,
              value,
            ]),
          ),
        }
      : { ...EVOLUTION_DEFAULTS[namespace] }
  }
  #record(
    namespace: EvolutionNamespace,
    param: string,
    before: number,
    after: number,
    reason: string,
    signal: EvolutionSignal,
    action: EvolutionAction,
  ): EvolutionRecord {
    return {
      namespace,
      param,
      before,
      after,
      at: this.#options.now().toISOString(),
      reason,
      signal,
      action,
    }
  }
  async #restore() {
    if (this.#restored || !this.persistence.audit) return
    const records = await this.persistence.audit()
    for (const record of records) {
      const key = `${record.namespace}:${record.param}`
      if (record.action === 'adjusted') this.#last.set(key, record)
      if (record.action === 'rolled_back') this.#worsen.set(key, (this.#worsen.get(key) ?? 0) + 1)
      if (record.action === 'stopped' || record.action === 'confirmation_rejected')
        this.#stopped.add(key)
    }
    this.#restored = true
  }
  async #evaluate(namespace: EvolutionNamespace, signal: EvolutionSignal) {
    const values = await this.values(namespace)
    if (namespace === 'context') {
      if ((signal.post_compact_repeat_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'compaction_threshold',
          values.compaction_threshold! + 0.05,
          'post-compaction repeat rate exceeded 0.2',
          signal,
        )
      if ((signal.context_length_error_rate ?? 0) > 0.1)
        return this.propose(
          namespace,
          'compaction_threshold',
          values.compaction_threshold! - 0.05,
          'context length error rate exceeded 0.1',
          signal,
        )
      if ((signal.immediate_recompact_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'target_ratio',
          values.target_ratio! - 0.05,
          'immediate recompaction rate exceeded 0.2',
          signal,
        )
      if ((signal.keep_outside_window_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'keep_recent',
          values.keep_recent! + 2,
          'kept messages frequently fell outside the recent window',
          signal,
        )
      if ((signal.summary_recent_loss_rate ?? 0) > 0.2)
        return this.propose(
          namespace,
          'summary_keep_recent',
          values.summary_keep_recent! + 2,
          'recent context was frequently lost after summary',
          signal,
        )
    }
    if (namespace === 'router' && (signal.fallback_success_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'cooldown_ms',
        values.cooldown_ms! - 10_000,
        'fallback frequently succeeds; reduce cooldown',
        signal,
      )
    if (namespace === 'retry' && (signal.retry_success_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'max_retries',
        values.max_retries! + 1,
        'retries frequently succeed',
        signal,
      )
    if (namespace === 'retry' && (signal.retry_failure_rate ?? 0) > 0.5)
      return this.propose(
        namespace,
        'max_retries',
        values.max_retries! - 1,
        'retries frequently fail',
        signal,
      )
    if (
      namespace === 'tool-timeout' &&
      (signal.timeout_rate ?? 0) > 0.2 &&
      (signal.user_retry_rate ?? 0) > 0.2
    )
      return this.propose(
        namespace,
        'default_timeout_ms',
        values.default_timeout_ms! + 10_000,
        'tool timeouts are frequently retried by the user',
        signal,
      )
  }
}
