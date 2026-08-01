import {
  anthropicCapabilities,
  mapAnthropicError,
  parseAnthropicSse,
} from '@apollo-code/provider-anthropic'
import { mapOpenAIError, openaiCapabilities, parseOpenAISse } from '@apollo-code/provider-openai'
import { describe, expect, it } from 'vitest'

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(value)
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

describe.each([
  ['anthropic', anthropicCapabilities, mapAnthropicError, parseAnthropicSse],
  ['openai', openaiCapabilities, mapOpenAIError, parseOpenAISse],
] as const)('%s shared provider contract', (_name, capabilities, mapError, parser) => {
  it('declares streaming, tools, vision, and bounded context capabilities', () => {
    expect(capabilities.streaming).toBe(true)
    expect(capabilities.toolUse).not.toBe('none')
    expect(capabilities.vision).not.toBe(false)
    expect(capabilities.maxContextTokens).toBeGreaterThan(0)
  })

  it('classifies auth, throttling, and server errors consistently', () => {
    expect(mapError(401).category).toBe('auth')
    expect(mapError(429).category).toBe('rate_limit')
    expect(mapError(500).category).toBe('server')
  })

  it('reports an offline truncated stream through the neutral interruption chunk', async () => {
    const result = await collect(parser(chunks('incomplete')))
    expect(result.at(-1)?.kind).toBe('message.interrupted')
  })
})
