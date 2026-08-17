import { describe, expect, it, vi } from 'vitest'

import { NativeProbeCoordinator } from './probe'
import type { NativeProbeSources } from './probe'
import type { SandboxInfo } from './types'

const fullSandbox: SandboxInfo = {
  platform: 'darwin',
  arch: 'arm64',
  libc: null,
  os_version: '25.0',
  tier: 'full',
  features: { mechanism: 'seatbelt' },
  known_limitations: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function sources(overrides: Partial<NativeProbeSources> = {}) {
  return {
    sandbox: vi.fn(async () => fullSandbox),
    worker: vi.fn(async () => true),
    ...overrides,
  }
}

describe('NativeProbeCoordinator', () => {
  it('starts all probes concurrently; no probe waits for another', async () => {
    const sandboxProbe = deferred<SandboxInfo>()
    const coordinator = new NativeProbeCoordinator()
    coordinator.registerSources(
      sources({
        sandbox: () => sandboxProbe.promise,
        worker: vi.fn(async () => {
          throw new Error('worker handshake failed')
        }),
      }),
    )
    coordinator.start()
    await new Promise((resolve) => setImmediate(resolve))
    // Both worker probes already ran to completion while the sandbox probe hangs.
    expect(coordinator.available).toMatchObject({ sandbox: 'probing', search: false, fs: false })
    sandboxProbe.resolve({ ...fullSandbox, tier: 'partial' })
    await coordinator.settled()
    expect(coordinator.available).toMatchObject({
      sandbox: true,
      search: false,
      fs: false,
      sandbox_tier: 'partial',
    })
  })

  it('reports probing for every kind before backfill and freezes the tier at probe completion', async () => {
    const coordinator = new NativeProbeCoordinator()
    const sandboxProbe = deferred<SandboxInfo>()
    const seen: string[] = []
    coordinator.registerSources({
      sandbox: () => sandboxProbe.promise,
      worker: async (kind) => kind === 'fs',
    })
    coordinator.subscribe((available) =>
      seen.push(`${available.sandbox}:${available.search}:${available.fs}`),
    )
    expect(coordinator.available).toMatchObject({
      sandbox: 'probing',
      search: 'probing',
      fs: 'probing',
      sandbox_tier: 'none',
      sandbox_info: null,
    })
    await new Promise((resolve) => setImmediate(resolve))
    // Worker probes backfilled while the sandbox probe is still pending.
    expect(coordinator.available).toMatchObject({
      sandbox: 'probing',
      search: false,
      fs: true,
      sandbox_tier: 'none',
    })
    expect(seen).toContain('probing:false:probing')
    sandboxProbe.resolve({ ...fullSandbox, tier: 'weak' })
    await coordinator.settled()
    expect(coordinator.available).toMatchObject({
      sandbox: true,
      search: false,
      fs: true,
      sandbox_tier: 'weak',
    })
    expect(coordinator.available.sandbox_info).toMatchObject({ tier: 'weak' })
    expect(seen.at(-1)).toBe('true:false:true')
  })

  it('launches probes synchronously on start (parallel, not serialized)', () => {
    const calls: string[] = []
    const coordinator = new NativeProbeCoordinator()
    coordinator.registerSources({
      sandbox: () => {
        calls.push('sandbox')
        return new Promise<SandboxInfo>(() => {})
      },
      worker: (kind) => {
        calls.push(kind)
        return new Promise<boolean>(() => {})
      },
    })
    coordinator.start()
    expect(calls).toEqual(['sandbox', 'search', 'fs'])
  })

  it('force-settles a hanging probe as unavailable when the budget expires', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new NativeProbeCoordinator({ budgetMs: 5_000 })
      coordinator.registerSources(
        sources({
          sandbox: () => new Promise<SandboxInfo>(() => {}),
          worker: () => new Promise<boolean>(() => {}),
        }),
      )
      coordinator.start()
      expect(coordinator.available.sandbox).toBe('probing')
      await vi.advanceTimersByTimeAsync(5_001)
      expect(coordinator.available).toMatchObject({ sandbox: false, search: false, fs: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a pending probe with the remaining budget only', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new NativeProbeCoordinator({ budgetMs: 5_000 })
      const sandboxProbe = deferred<SandboxInfo>()
      coordinator.registerSources(sources({ sandbox: () => sandboxProbe.promise }))
      coordinator.start()
      await vi.advanceTimersByTimeAsync(3_000)
      const waited = coordinator.waitFor('sandbox')
      // Only ~2s of budget remain; the hanging probe must not outlive it.
      await vi.advanceTimersByTimeAsync(2_001)
      await expect(waited).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves waitFor immediately for settled probes without re-probing', async () => {
    const coordinator = new NativeProbeCoordinator()
    const worker = vi.fn(async () => false)
    coordinator.registerSources(sources({ worker }))
    coordinator.start()
    await coordinator.settled()
    const before = worker.mock.calls.length
    await expect(coordinator.waitFor('fs')).resolves.toBe(false)
    expect(worker).toHaveBeenCalledTimes(before)
  })

  it('treats a sandbox probe that reports tier none as unavailable', async () => {
    const coordinator = new NativeProbeCoordinator()
    coordinator.registerSources(
      sources({ sandbox: async () => ({ ...fullSandbox, tier: 'none' }) }),
    )
    coordinator.start()
    await coordinator.settled()
    expect(coordinator.available).toMatchObject({ sandbox: false, sandbox_tier: 'none' })
    expect(coordinator.available.sandbox_info).not.toBeNull()
  })

  it('never re-probes after settlement (tier frozen for the session)', async () => {
    const coordinator = new NativeProbeCoordinator()
    const sandbox = vi.fn(async () => fullSandbox)
    coordinator.registerSources(sources({ sandbox }))
    coordinator.start()
    await coordinator.settled()
    coordinator.start()
    await coordinator.settled()
    expect(sandbox).toHaveBeenCalledTimes(1)
    expect(coordinator.available.sandbox_tier).toBe('full')
  })

  it('keeps start idempotent and safe to call repeatedly from concurrent callers', async () => {
    const coordinator = new NativeProbeCoordinator()
    const sandbox = vi.fn(async () => fullSandbox)
    coordinator.registerSources(sources({ sandbox }))
    coordinator.start()
    coordinator.start()
    await coordinator.settled()
    expect(sandbox).toHaveBeenCalledTimes(1)
  })
})
