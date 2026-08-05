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
  elapsedTimeMs?: number
  signal?: AbortSignal
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
  onSuccess?(decision: RouterDecision, ctx: RouterContext): Promise<void> | void
  init?(config: Record<string, unknown>): Promise<void>
  dispose?(): Promise<void>
}
export type Sleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>
const defaultSleep: Sleeper = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

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

export interface FallbackRoute {
  provider: ProviderClient
  model: string
  priority: number
}

export interface FallbackRouterOptions {
  cooldownMs?: number
  maxAttempts?: number
  maxRetriesPerProvider?: number
  clock?: () => number
  sleep?: Sleeper
  jitter?: (milliseconds: number) => number
}

interface ProviderHealth {
  retryCount: number
  cooldownUntil: number
  halfOpen: boolean
  failures: ProviderError[]
}

const NO_RETRY = new Set<ProviderError['category']>([
  'auth',
  'invalid_request',
  'context_length',
  'protocol',
  'permission',
  'sandbox',
  'cancelled',
])
const FALLBACK_IMMEDIATELY = new Set<ProviderError['category']>([
  'rate_limit',
  'quota',
  'content_filter',
  'model_not_found',
])

/** Priority fallback with per-provider circuit breaking and a single half-open probe. */
export class FallbackRouter implements RouterPolicy {
  readonly name = 'fallback'
  readonly #chain: readonly FallbackRoute[]
  readonly #health = new Map<string, ProviderHealth>()
  readonly #cooldownMs: number
  readonly #maxAttempts: number
  readonly #maxRetries: number
  readonly #clock: () => number
  readonly #sleep: Sleeper
  readonly #jitter: (milliseconds: number) => number

  constructor(chain: readonly FallbackRoute[], options: FallbackRouterOptions = {}) {
    if (chain.length === 0) throw new Error('fallback_chain_empty')
    const names = new Set<string>()
    for (const route of chain) {
      if (names.has(route.provider.name))
        throw new Error(`fallback_provider_duplicate: ${route.provider.name}`)
      names.add(route.provider.name)
      this.#health.set(route.provider.name, {
        retryCount: 0,
        cooldownUntil: 0,
        halfOpen: false,
        failures: [],
      })
    }
    this.#chain = [...chain].sort((a, b) => b.priority - a.priority)
    this.#cooldownMs = options.cooldownMs ?? 60_000
    this.#maxAttempts = options.maxAttempts ?? 6
    this.#maxRetries = options.maxRetriesPerProvider ?? 2
    this.#clock = options.clock ?? Date.now
    this.#sleep = options.sleep ?? defaultSleep
    this.#jitter = options.jitter ?? ((value) => value)
  }

  async pick(ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision> {
    const sticky = ctx.session.stickyProvider
    if (sticky) {
      const route = this.#route(sticky)
      if (!route) throw new Error(`sticky_provider_not_in_fallback_chain: ${sticky}`)
      return this.#decision(route, 'sticky-provider')
    }
    if (this.#exhausted(ctx)) throw new Error('router_budget_exhausted')
    const explicit = hint?.explicitModel
    if (explicit?.includes('/')) {
      const [providerName, ...model] = explicit.split('/')
      const route = this.#route(providerName!)
      if (!route) throw new Error(`provider_not_in_fallback_chain: ${providerName}`)
      return { ...this.#decision(route, 'explicit-provider'), model: model.join('/') }
    }
    const route = this.#availableRoute()
    if (!route) throw new Error('all_providers_cooling_down')
    return this.#decision(route, 'fallback-primary', explicit)
  }

  async onError(error: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'> {
    const route = this.#route(error.provider)
    if (
      !route ||
      this.#exhausted(ctx) ||
      NO_RETRY.has(error.category) ||
      (!error.retryable && !FALLBACK_IMMEDIATELY.has(error.category))
    )
      return 'give-up'
    const health = this.#health.get(error.provider)!
    health.failures.push(this.#safeError(error))
    health.halfOpen = false

    const sticky = ctx.session.stickyProvider
    if (sticky) {
      if (sticky !== error.provider || health.retryCount >= this.#maxRetries) return 'give-up'
      await this.#backoff(error, health.retryCount++, ctx.signal)
      return this.#decision(route, 'sticky-retry')
    }

    if (!FALLBACK_IMMEDIATELY.has(error.category) && health.retryCount < this.#maxRetries) {
      await this.#backoff(error, health.retryCount++, ctx.signal)
      return this.#decision(route, 'retry')
    }

    health.cooldownUntil = this.#clock() + Math.max(this.#cooldownMs, error.retryAfterMs ?? 0)
    const fallback = this.#availableRoute(error.provider)
    if (fallback) {
      health.retryCount = 0
      return this.#decision(fallback, 'fallback')
    }
    if (error.category === 'rate_limit' && health.retryCount < this.#maxRetries) {
      await this.#backoff(error, health.retryCount++, ctx.signal)
      health.cooldownUntil = 0
      return this.#decision(route, 'retry')
    }
    return 'give-up'
  }

  onSuccess(decision: RouterDecision, _ctx?: RouterContext): void {
    const health = this.#health.get(decision.provider.name)
    if (!health) return
    health.retryCount = 0
    health.cooldownUntil = 0
    health.halfOpen = false
    health.failures = []
  }

  failures(): Readonly<Record<string, readonly ProviderError[]>> {
    return Object.fromEntries(
      [...this.#health].map(([provider, health]) => [provider, [...health.failures]]),
    )
  }

  #availableRoute(exclude?: string): FallbackRoute | undefined {
    const now = this.#clock()
    for (const route of this.#chain) {
      if (route.provider.name === exclude) continue
      const health = this.#health.get(route.provider.name)!
      if (health.cooldownUntil === 0) return route
      if (health.cooldownUntil <= now && !health.halfOpen) {
        health.halfOpen = true
        return route
      }
    }
  }

  #route(name: string): FallbackRoute | undefined {
    return this.#chain.find((entry) => entry.provider.name === name)
  }

  #decision(route: FallbackRoute, reason: string, model = route.model): RouterDecision {
    return { provider: route.provider, model, reason }
  }

  #exhausted(ctx: RouterContext): boolean {
    return (
      ctx.signal?.aborted === true ||
      ctx.attemptCount >= this.#maxAttempts ||
      (ctx.budget?.costUSDMax !== undefined &&
        ctx.session.cumulativeCostUSD >= ctx.budget.costUSDMax) ||
      (ctx.budget?.timeMsMax !== undefined && (ctx.elapsedTimeMs ?? 0) >= ctx.budget.timeMsMax)
    )
  }

  async #backoff(error: ProviderError, retryCount: number, signal?: AbortSignal): Promise<void> {
    const milliseconds = error.retryAfterMs ?? 1_000 * 4 ** retryCount
    await this.#sleep(Math.max(0, this.#jitter(milliseconds)), signal)
  }

  #safeError(error: ProviderError): ProviderError {
    return Object.assign(new Error(error.message), {
      provider: error.provider,
      category: error.category,
      retryable: error.retryable,
      ...(error.model === undefined ? {} : { model: error.model }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    })
  }
}

export function assertProviderMayBeDefault(registry: ProviderRegistry, providerName: string) {
  if (registry.describe(providerName)?.source.kind === 'plugin')
    throw new Error('plugin_provider_cannot_be_default_v1')
}

export type RouterRole = NonNullable<RouterHint['role']>
export interface RoleRouteConfig {
  provider: string
  model: string
  priority?: number
}
export interface RoleRouterConfig {
  roles?: Partial<Record<RouterRole, RoleRouteConfig | readonly RoleRouteConfig[]>>
  default?: RoleRouteConfig | readonly RoleRouteConfig[]
}

const ROUTER_ROLES: readonly RouterRole[] = ['planner', 'coder', 'reviewer', 'chat']

/** Role selection layered over FallbackRouter's retry, cooldown, budget, and sticky policy. */
export class RoleRouter implements RouterPolicy {
  readonly name = 'role'
  readonly #registry: ProviderRegistry
  readonly #default: FallbackRouter
  readonly #roles = new Map<RouterRole, FallbackRouter>()
  readonly #providerRouters = new Map<string, FallbackRouter>()
  readonly #activeTurns = new Map<string, FallbackRouter>()
  readonly #options: FallbackRouterOptions
  readonly #maxTrackedTurns: number

  constructor(
    registry: ProviderRegistry,
    config: RoleRouterConfig,
    options: FallbackRouterOptions & { maxTrackedTurns?: number } = {},
  ) {
    if (!config.default) throw new Error('role_router_default_missing')
    this.#registry = registry
    this.#options = options
    this.#maxTrackedTurns = Math.max(1, options.maxTrackedTurns ?? 256)
    const defaults = this.#normalize(config.default, 'default')
    assertProviderMayBeDefault(registry, defaults[0]!.provider)
    this.#default = this.#fallback(defaults)
    for (const route of defaults) this.#providerRouters.set(route.provider, this.#default)
    for (const role of ROUTER_ROLES) {
      const configured = config.roles?.[role]
      if (!configured) continue
      const routes = this.#normalize(configured, role)
      const router = this.#fallback(routes)
      this.#roles.set(role, router)
      for (const route of routes) this.#providerRouters.set(route.provider, router)
    }
  }

  async pick(ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision> {
    const active = this.#activeTurns.get(ctx.turnId)
    if (ctx.session.stickyProvider) {
      const router = active ?? this.#providerRouters.get(ctx.session.stickyProvider)
      if (!router)
        throw new Error(`sticky_provider_not_in_role_candidates: ${ctx.session.stickyProvider}`)
      this.#track(ctx.turnId, router)
      return router.pick(ctx)
    }

    if (hint?.explicitModel?.includes('/')) {
      const [providerName, ...model] = hint.explicitModel.split('/')
      const provider = this.#registry.get(providerName!)
      if (!provider) throw new Error(`provider_not_registered: ${providerName}`)
      const router = new FallbackRouter(
        [{ provider, model: model.join('/'), priority: 0 }],
        this.#options,
      )
      this.#track(ctx.turnId, router)
      return router.pick(ctx, hint)
    }

    const role = hint?.role
    const router = (role && this.#roles.get(role)) || this.#default
    this.#track(ctx.turnId, router)
    const decision = await router.pick(ctx, hint)
    return {
      ...decision,
      reason: `role:${role && this.#roles.has(role) ? role : 'default'}`,
      metadata: { ...decision.metadata, fallbackReason: decision.reason },
    }
  }

  async onError(error: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'> {
    return (await this.#activeTurns.get(ctx.turnId)?.onError(error, ctx)) ?? 'give-up'
  }

  async onSuccess(decision: RouterDecision, ctx: RouterContext): Promise<void> {
    await Promise.resolve(this.#activeTurns.get(ctx.turnId)?.onSuccess?.(decision, ctx))
  }

  #normalize(
    configured: RoleRouteConfig | readonly RoleRouteConfig[],
    label: string,
  ): readonly RoleRouteConfig[] {
    const routes = Array.isArray(configured) ? configured : [configured]
    if (routes.length === 0) throw new Error(`role_router_candidates_empty: ${label}`)
    return routes
  }

  #fallback(configured: readonly RoleRouteConfig[]): FallbackRouter {
    return new FallbackRouter(
      configured.map((route, index) => {
        const provider = this.#registry.get(route.provider)
        if (!provider) throw new Error(`provider_not_registered: ${route.provider}`)
        return { provider, model: route.model, priority: route.priority ?? -index }
      }),
      this.#options,
    )
  }

  #track(turnId: string, router: FallbackRouter): void {
    this.#activeTurns.delete(turnId)
    this.#activeTurns.set(turnId, router)
    while (this.#activeTurns.size > this.#maxTrackedTurns)
      this.#activeTurns.delete(this.#activeTurns.keys().next().value!)
  }
}

/** Validates the untyped `[router]` config before any provider can receive traffic. */
export function parseRoleRouterConfig(value: unknown): RoleRouterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('role_router_config_invalid')
  const input = value as Record<string, unknown>
  const config: RoleRouterConfig = { default: parseConfiguredRoutes(input.default, 'default') }
  if (input.roles !== undefined) {
    if (!input.roles || typeof input.roles !== 'object' || Array.isArray(input.roles))
      throw new Error('role_router_roles_invalid')
    const roles = input.roles as Record<string, unknown>
    const unknown = Object.keys(roles).find((role) => !ROUTER_ROLES.includes(role as RouterRole))
    if (unknown) throw new Error(`role_router_role_unknown: ${unknown}`)
    const parsed: Partial<Record<RouterRole, RoleRouteConfig | readonly RoleRouteConfig[]>> = {}
    for (const role of ROUTER_ROLES)
      if (roles[role] !== undefined) parsed[role] = parseConfiguredRoutes(roles[role], role)
    config.roles = parsed
  }
  return config
}

function parseConfiguredRoutes(
  value: unknown,
  label: string,
): RoleRouteConfig | readonly RoleRouteConfig[] {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`role_router_candidates_empty: ${label}`)
    return value.map((route) => parseConfiguredRoute(route, label))
  }
  return parseConfiguredRoute(value, label)
}

function parseConfiguredRoute(value: unknown, label: string): RoleRouteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`role_router_route_invalid: ${label}`)
  const route = value as Record<string, unknown>
  if (
    typeof route.provider !== 'string' ||
    !route.provider ||
    typeof route.model !== 'string' ||
    !route.model
  )
    throw new Error(`role_router_route_invalid: ${label}`)
  if (
    route.priority !== undefined &&
    (!Number.isFinite(route.priority) || typeof route.priority !== 'number')
  )
    throw new Error(`role_router_priority_invalid: ${label}`)
  return {
    provider: route.provider,
    model: route.model,
    ...(route.priority === undefined ? {} : { priority: route.priority }),
  }
}
