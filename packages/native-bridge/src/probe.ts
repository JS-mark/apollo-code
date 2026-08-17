import type { SandboxInfo, SandboxTier } from './types'

/**
 * r13-P1 startup timing contract (spec 05-rust-sidecar.md §5.8):
 * 1. every probe is launched in parallel; none waits for another
 * 2. `available.*` starts as `'probing'` and is backfilled asynchronously —
 *    the REPL must never block on a probe
 * 3. side-effect callers may `waitFor` a probe, bounded by the remaining budget;
 *    read-only callers must not wait (JS fallback first, native after backfill)
 * 4. the sandbox tier freezes at probe completion for the whole session
 */
export type ProbeKind = 'sandbox' | 'search' | 'fs'
export type ProbeAvailability = boolean | 'probing'

export interface NativeProbeSources {
  /** Resolves the frozen sandbox probe result; tier `none` means unavailable. */
  sandbox(): Promise<Readonly<SandboxInfo>>
  /** Resolves true when the search/fs binary resolved and the worker handshook. */
  worker(kind: 'search' | 'fs'): Promise<boolean>
}

export interface NativeAvailability {
  readonly sandbox: ProbeAvailability
  readonly search: ProbeAvailability
  readonly fs: ProbeAvailability
  /** `'none'` until the sandbox probe settles; frozen afterwards for the session. */
  readonly sandbox_tier: SandboxTier
  readonly sandbox_info: Readonly<SandboxInfo> | null
}

type Settle = (available: boolean) => void

const unavailableSandbox: Readonly<SandboxInfo> = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  libc: null,
  os_version: '',
  tier: 'none',
  features: Object.freeze({}),
  known_limitations: Object.freeze(['native probing not wired']),
})

/**
 * Coordinates the three native probes. Probes are memoized for the process:
 * `start()` is idempotent and a settled kind never probes again (tier freeze).
 */
export class NativeProbeCoordinator {
  readonly #budgetMs: number
  #sources: NativeProbeSources | undefined
  #startedAt: number | undefined
  #sandboxTier: SandboxTier = 'none'
  #sandboxInfo: Readonly<SandboxInfo> | null = null
  #state: Record<ProbeKind, ProbeAvailability> = {
    sandbox: 'probing',
    search: 'probing',
    fs: 'probing',
  }
  #waiters = new Map<ProbeKind, Settle>()
  #allSettled: Promise<void> | undefined
  #listeners = new Set<(available: NativeAvailability) => void>()

  constructor(options: { budgetMs?: number } = {}) {
    this.#budgetMs = options.budgetMs ?? 5_000
  }

  /** Wires probe implementations; ignored once probing started (sources frozen). */
  registerSources(sources: NativeProbeSources): void {
    if (this.#startedAt !== undefined) return
    this.#sources = sources
  }

  /** Fires the sandbox probe and both worker probes concurrently. Idempotent. */
  start(): void {
    if (this.#startedAt !== undefined) return
    this.#startedAt = Date.now()
    const sources =
      this.#sources ??
      ({
        sandbox: async () => unavailableSandbox,
        worker: async () => false,
      } satisfies NativeProbeSources)
    // Budget expiry is the hard backstop: even a probe whose underlying promise
    // never settles (e.g. a stalled binary download) backfills as unavailable.
    const deadline = setTimeout(() => {
      for (const kind of ['sandbox', 'search', 'fs'] as const) this.#settle(kind, false)
    }, this.#budgetMs)
    deadline.unref?.()
    // Each promise is created eagerly so all probes run in parallel; the
    // allSettled join only tracks completion and never couples the probes.
    const probes = [
      sources.sandbox().then(
        (info) => {
          this.#sandboxTier = info.tier
          this.#sandboxInfo = info
          this.#settle('sandbox', info.tier !== 'none')
        },
        () => this.#settle('sandbox', false),
      ),
      sources.worker('search').then(
        (ok) => this.#settle('search', ok),
        () => this.#settle('search', false),
      ),
      sources.worker('fs').then(
        (ok) => this.#settle('fs', ok),
        () => this.#settle('fs', false),
      ),
    ]
    this.#allSettled = Promise.allSettled(probes).then(() => undefined)
  }

  /** Tri-state snapshot; reading it lazily starts the probes. */
  get available(): NativeAvailability {
    this.start()
    return {
      ...this.#state,
      sandbox_tier: this.#sandboxTier,
      sandbox_info: this.#sandboxInfo,
    }
  }

  get probing(): boolean {
    return Object.values(this.#state).some((state) => state === 'probing')
  }

  /**
   * Waits for one probe to settle, bounded by the remaining startup budget.
   * Resolves false once the budget is exhausted even if the probe hangs.
   * Without wired sources (deep imports bypassing the package entry) the
   * outcome is undetermined and the caller's own probe await governs.
   */
  waitFor(kind: ProbeKind): Promise<boolean> {
    if (!this.#sources) return Promise.resolve(true)
    this.start()
    const state = this.#state[kind]
    if (state !== 'probing') return Promise.resolve(state)
    const remaining = this.#deadline() - Date.now()
    if (remaining <= 0) {
      this.#settle(kind, false)
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      const previous = this.#waiters.get(kind)
      this.#waiters.set(kind, (available) => {
        previous?.(available)
        resolve(available)
      })
    })
  }

  /** Resolves when every probe settled (or its budget expired). */
  settled(): Promise<void> {
    this.start()
    return this.#allSettled ?? Promise.resolve()
  }

  subscribe(listener: (available: NativeAvailability) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #deadline(): number {
    return (this.#startedAt ?? Date.now()) + this.#budgetMs
  }

  #settle(kind: ProbeKind, available: boolean): void {
    if (this.#state[kind] !== 'probing') return
    this.#state[kind] = available
    this.#waiters.get(kind)?.(available)
    this.#waiters.delete(kind)
    const snapshot = this.available
    for (const listener of this.#listeners) listener(snapshot)
  }
}

/** Process-wide coordinator; sources are wired in `index.ts`. */
export const nativeProbes = new NativeProbeCoordinator()
