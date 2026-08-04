import type { ProviderClient, ProviderError, ProviderRegistry } from '@apollo-code/provider-kit'

export interface RouterSessionSnapshot {
  id: string
  cumulativeCostUSD: number
  lastProvider?: string
  stickyProvider?: string
}
export interface RouterContext {
  session: RouterSessionSnapshot
  turnId: string
  attemptCount: number
  budget?: { costUSDMax?: number; timeMsMax?: number }
}
export interface RouterHint {
  explicitModel?: string
  role?: 'planner' | 'coder' | 'reviewer' | 'chat'
  costPreference?: 'cheap' | 'balanced' | 'quality'
}
export interface RouterDecision {
  provider: ProviderClient
  model: string
  reason: string
  metadata?: Record<string, unknown>
}
export interface RouterPolicy {
  readonly name: string
  pick(ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision>
  onError(error: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'>
  init?(config: Record<string, unknown>): Promise<void>
  dispose?(): Promise<void>
}
export type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>
const defaultSleep: Sleeper = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export class SingleProviderRouter implements RouterPolicy {
  readonly name = 'single-provider'
  constructor(
    readonly client: ProviderClient,
    readonly defaultModel: string,
    private readonly sleep: Sleeper = defaultSleep,
    private readonly registry?: ProviderRegistry,
  ) {}
  async pick(_ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision> {
    const explicit = hint?.explicitModel
    if (explicit?.includes('/')) {
      const [providerName, ...modelParts] = explicit.split('/')
      const provider = this.registry?.get(providerName!)
      if (!provider) throw new Error(`provider_not_registered: ${providerName}`)
      return { provider, model: modelParts.join('/'), reason: 'explicit-provider' }
    }
    return {
      provider: this.client,
      model: explicit ?? this.defaultModel,
      reason: 'single-provider',
    }
  }
  async onError(error: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'> {
    if (!error.retryable || error.category === 'context_length' || ctx.attemptCount >= 3)
      return 'give-up'
    await this.sleep(error.retryAfterMs ?? 1_000 * 4 ** ctx.attemptCount)
    return { provider: this.client, model: this.defaultModel, reason: 'retry' }
  }
}

export function assertProviderMayBeDefault(registry: ProviderRegistry, providerName: string) {
  if (registry.describe(providerName)?.source.kind === 'plugin')
    throw new Error('plugin_provider_cannot_be_default_v1')
}
