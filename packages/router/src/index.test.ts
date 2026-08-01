import type { ProviderClient, ProviderError } from '@apollo-code/provider-kit'
import { describe, expect, it, vi } from 'vitest'

import { SingleProviderRouter } from './index.ts'

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
