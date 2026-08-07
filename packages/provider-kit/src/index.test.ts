import { describe, expectTypeOf, it } from 'vitest'

import type {
  ContextPolicy,
  Message,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  EmbeddingProvider,
  ProviderRequest,
  RawMeta,
} from './index'

describe('provider contract', () => {
  it('requires the complete L1 ProviderClient surface', () => {
    expectTypeOf<ProviderClient>().toHaveProperty('name').toEqualTypeOf<string>()
    expectTypeOf<ProviderClient>()
      .toHaveProperty('capabilities')
      .toEqualTypeOf<ProviderCapabilities>()
    expectTypeOf<ProviderClient['stream']>().parameters.toEqualTypeOf<
      [ProviderRequest, AbortSignal]
    >()
    expectTypeOf<ProviderClient['dispose']>().returns.toEqualTypeOf<Promise<void>>()
  })

  it('keeps multimodal messages and provider-native metadata at the boundary', () => {
    expectTypeOf<Message['content'][number]['type']>().toEqualTypeOf<
      'text' | 'thinking' | 'image' | 'file' | 'tool_use' | 'tool_result'
    >()
    expectTypeOf<ProviderRequest>().toHaveProperty('rawMeta').toEqualTypeOf<RawMeta | undefined>()
  })

  it('makes normal completion, interruption, usage, tools, and errors explicit chunks', () => {
    type Kind = ProviderChunk['kind']
    expectTypeOf<Kind>().toEqualTypeOf<
      | 'message.start'
      | 'text.delta'
      | 'thinking.delta'
      | 'tool_use.start'
      | 'tool_use.delta'
      | 'tool_use.end'
      | 'usage'
      | 'message.stop'
      | 'message.interrupted'
      | 'error'
    >()
  })

  it('owns the replaceable context policy contract', () => {
    expectTypeOf<ContextPolicy>().toHaveProperty('shouldCompact')
    expectTypeOf<ContextPolicy>().toHaveProperty('buildPrompt')
    expectTypeOf<ContextPolicy>().toHaveProperty('compact')
    expectTypeOf<ContextPolicy>().toHaveProperty('estimateTokens')
  })

  it('keeps embedding providers local-first and explicit at the provider boundary', () => {
    expectTypeOf<EmbeddingProvider>().toHaveProperty('scope').toEqualTypeOf<'cloud' | 'local'>()
    expectTypeOf<EmbeddingProvider['embed']>().parameters.toEqualTypeOf<
      [
        {
          readonly model: string
          readonly input: readonly string[]
          readonly purpose: 'semantic-recall'
        },
        AbortSignal,
      ]
    >()
  })
})
