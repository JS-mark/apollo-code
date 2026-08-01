import type { ProviderClient, ProviderError } from '@apollo-code/provider-kit'

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
  ) {}
  async pick(_ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision> {
    return {
      provider: this.client,
      model: hint?.explicitModel ?? this.defaultModel,
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
