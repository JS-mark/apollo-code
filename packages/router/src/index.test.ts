import {
  InMemoryProviderRegistry,
  type ProviderClient,
  type ProviderError,
} from '@apollo-code/provider-kit'
import { describe, expect, it, vi } from 'vitest'

import { FallbackRouter, SingleProviderRouter } from './index'

const client = {
  name: 'fake',
  capabilities: {},
  dispose: async () => {},
  stream: async function* () {},
} as unknown as ProviderClient
const ctx = { session: { id: 's', cumulativeCostUSD: 0 }, turnId: 't', attemptCount: 0 }
describe('SingleProviderRouter', () => {
  it('honors an explicit model', async () => {
    expect(
      (await new SingleProviderRouter(client, 'default').pick(ctx, { explicitModel: 'chosen' }))
        .model,
    ).toBe('chosen')
  })
  it('resolves only explicitly named plugin providers through the registry', async () => {
    const registry = new InMemoryProviderRegistry()
    const plugin = { ...client, name: 'plugin-vllm' }
    registry.register(
      plugin,
      { kind: 'plugin', plugin: 'apollo-plugin-provider-vllm' },
      {
        capabilities: plugin.capabilities,
        displayName: 'vLLM',
      },
    )
    const decision = await new SingleProviderRouter(client, 'default', undefined, registry).pick(
      ctx,
      { explicitModel: 'plugin-vllm/llama-3' },
    )
    expect(decision).toMatchObject({
      provider: plugin,
      model: 'llama-3',
      reason: 'explicit-provider',
    })
    await expect(
      new SingleProviderRouter(client, 'default', undefined, registry).pick(ctx, {
        explicitModel: 'missing/model',
      }),
    ).rejects.toThrow('provider_not_registered')
  })
  it('retries retryable errors and gives up otherwise', async () => {
    const sleep = vi.fn(async () => {})
    const router = new SingleProviderRouter(client, 'model', sleep)
    const retryable = Object.assign(new Error('rate'), {
      provider: 'fake',
      category: 'rate_limit',
      retryable: true,
      retryAfterMs: 7,
    }) as ProviderError
    expect(await router.onError(retryable, ctx)).toMatchObject({ reason: 'retry' })
    expect(sleep).toHaveBeenCalledWith(7)
    expect(await router.onError({ ...retryable, retryable: false }, ctx)).toBe('give-up')
    expect(await router.onError(retryable, { ...ctx, attemptCount: 3 })).toBe('give-up')
  })
})

const otherClient = { ...client, name: 'other' } as ProviderClient
const providerError = (
  provider: string,
  category: ProviderError['category'],
  retryable = true,
  retryAfterMs?: number,
) =>
  Object.assign(new Error(`${provider}:${category}`), {
    provider,
    category,
    retryable,
    retryAfterMs,
  }) as ProviderError

describe('FallbackRouter', () => {
  it('falls back for provider-specific terminal errors but never retries request errors', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { sleep },
    )

    expect(
      await router.onError(providerError('fake', 'model_not_found', false), ctx),
    ).toMatchObject({ provider: otherClient, reason: 'fallback' })
    expect(await router.onError(providerError('fake', 'auth', true), ctx)).toBe('give-up')
    expect(await router.onError(providerError('fake', 'invalid_request', true), ctx)).toBe(
      'give-up',
    )
    expect(await router.onError(providerError('fake', 'context_length', true), ctx)).toBe('give-up')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries transient failures with retry-after, then cools and falls back', async () => {
    let now = 0
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { clock: () => now, sleep, cooldownMs: 10_000, maxRetriesPerProvider: 2 },
    )
    const error = providerError('fake', 'network')

    expect(await router.onError(error, ctx)).toMatchObject({ provider: client, reason: 'retry' })
    expect(await router.onError(error, { ...ctx, attemptCount: 1 })).toMatchObject({
      provider: client,
      reason: 'retry',
    })
    expect(await router.onError(error, { ...ctx, attemptCount: 2 })).toMatchObject({
      provider: otherClient,
      reason: 'fallback',
    })
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, undefined)
    expect(sleep).toHaveBeenNthCalledWith(2, 4_000, undefined)

    await router.onSuccess(await router.pick(ctx), ctx)
    now = 10_001
    expect((await router.pick(ctx)).provider).toBe(client)
    expect((await router.pick(ctx)).provider).toBe(otherClient)
  })

  it('honors sticky providers, budgets, attempts, and cancellation', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter(
      [
        { provider: client, model: 'primary', priority: 100 },
        { provider: otherClient, model: 'secondary', priority: 50 },
      ],
      { sleep, maxAttempts: 3 },
    )
    const stickyCtx = { ...ctx, session: { ...ctx.session, stickyProvider: 'fake' } }
    expect((await router.pick(stickyCtx)).provider).toBe(client)
    expect(await router.onError(providerError('fake', 'rate_limit'), stickyCtx)).toMatchObject({
      provider: client,
      reason: 'sticky-retry',
    })
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, attemptCount: 3 }),
    ).toBe('give-up')
    expect(
      await router.onError(providerError('fake', 'network'), {
        ...ctx,
        budget: { costUSDMax: 1, timeMsMax: 10 },
        elapsedTimeMs: 10,
        session: { ...ctx.session, cumulativeCostUSD: 1 },
      }),
    ).toBe('give-up')
    const controller = new AbortController()
    controller.abort()
    expect(
      await router.onError(providerError('fake', 'network'), { ...ctx, signal: controller.signal }),
    ).toBe('give-up')
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('uses retry-after when rate limited without an available fallback', async () => {
    const sleep = vi.fn(async () => {})
    const router = new FallbackRouter([{ provider: client, model: 'primary', priority: 100 }], {
      sleep,
    })
    expect(
      await router.onError(providerError('fake', 'rate_limit', true, 12_345), ctx),
    ).toMatchObject({ provider: client, reason: 'retry' })
    expect(sleep).toHaveBeenCalledWith(12_345, undefined)
  })
})
