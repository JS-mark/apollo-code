import { describe, expect, it, vi } from 'vitest'

import {
  GeminiClient,
  type HttpRequest,
  mapGeminiError,
  parseGeminiSse,
  toGeminiContents,
} from './index'

async function* chunks(parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* parts
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}
const bytes = (value: string) => new TextEncoder().encode(value)

describe('Gemini adapter', () => {
  it('places the composed system prompt in the first user message and maps tool parts', async () => {
    expect(
      await toGeminiContents(
        [
          {
            id: 'assistant',
            role: 'assistant',
            createdAt: 0,
            content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } }],
          },
          {
            id: 'user',
            role: 'user',
            createdAt: 1,
            content: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
          },
        ],
        undefined,
        'composed',
      ),
    ).toEqual([
      { role: 'user', parts: [{ text: 'composed' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] },
      {
        role: 'function',
        parts: [{ functionResponse: { name: 'read', response: { output: 'ok' } } }],
      },
    ])
  })

  it('normalizes fragmented UTF-8 SSE JSON lines, tool calls, usage, and stop', async () => {
    const stream = [
      'data: {"candidates":[{"content":{"parts":[{"text":"😀"},{"functionCall":{"name":"read","args":{"path":"a"}}}]},"finishReason":null}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"cachedContentTokenCount":2}}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" done"}]},"finishReason":"STOP"}]}\n\n',
    ].join('')
    const encoded = bytes(stream)
    const split = encoded.indexOf(0xf0) + 2
    const result = await collect(
      parseGeminiSse(chunks([encoded.slice(0, split), encoded.slice(split)])),
    )
    expect(result[0]).toMatchObject({ kind: 'message.start' })
    expect(result).toContainEqual({ kind: 'text.delta', text: '😀' })
    const start = result.find((chunk) => chunk.kind === 'tool_use.start')
    expect(start).toMatchObject({ kind: 'tool_use.start', name: 'read' })
    expect(result).toContainEqual({
      kind: 'tool_use.delta',
      id: start && 'id' in start ? start.id : '',
      argsFragment: '{"path":"a"}',
    })
    expect(result).toContainEqual({ kind: 'usage', usage: { input: 10, output: 4, cacheRead: 2 } })
    expect(result.at(-1)).toEqual({ kind: 'message.stop', stopReason: 'end_turn' })
  })

  it('maps safety, quota, context, auth, and server errors', () => {
    expect(mapGeminiError(401).category).toBe('auth')
    expect(mapGeminiError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).category).toBe(
      'rate_limit',
    )
    expect(mapGeminiError(400, { error: { message: 'input token limit exceeded' } }).category).toBe(
      'context_length',
    )
    expect(mapGeminiError(400, { error: { status: 'SAFETY' } }).category).toBe('content_filter')
    expect(mapGeminiError(500).retryable).toBe(true)
  })

  it('maps request controls, functionDeclarations, safety, and JSON response mode', async () => {
    const request = vi.fn(async (_input: HttpRequest) => ({
      status: 200,
      body: chunks([bytes('data: {"candidates":[{"finishReason":"STOP"}]}\n\n')]),
    }))
    const client = new GeminiClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
      model: 'gemini-test',
    })
    await collect(
      client.stream(
        {
          model: 'gemini-test',
          messages: [],
          system: 'system',
          tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
          toolChoice: { name: 'read' },
          maxTokens: 42,
          temperature: 0.2,
          topP: 0.8,
          stopSequences: ['END'],
          responseFormat: 'json',
          rawMeta: {
            gemini: {
              safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
              candidateCount: 2,
            },
          },
        },
        new AbortController().signal,
      ),
    )
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
      headers: { 'x-goog-api-key': 'secret' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'system' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'read', description: 'Read', parameters: { type: 'object' } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } },
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
        generationConfig: {
          maxOutputTokens: 42,
          temperature: 0.2,
          topP: 0.8,
          stopSequences: ['END'],
          responseMimeType: 'application/json',
          candidateCount: 2,
        },
      },
    })
  })

  it('uses the countTokens endpoint with the configured model and tools', async () => {
    const request = vi.fn(async (_input: HttpRequest) => ({
      status: 200,
      body: chunks([bytes('{"totalTokens":17}')]),
    }))
    const client = new GeminiClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
      model: 'gemini-test',
    })
    await expect(
      client.countTokens(
        [{ id: 'u', role: 'user', createdAt: 0, content: [{ type: 'text', text: 'hello' }] }],
        [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
      ),
    ).resolves.toBe(17)
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:countTokens',
      headers: { 'x-goog-api-key': 'secret' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'read', description: 'Read', parameters: { type: 'object' } },
            ],
          },
        ],
      },
    })
  })
})
