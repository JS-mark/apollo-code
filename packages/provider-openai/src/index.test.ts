import { describe, expect, it, vi } from 'vitest'

import {
  OpenAIClient,
  type HttpRequest,
  mapOpenAIError,
  parseOpenAISse,
  toOpenAIMessages,
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

describe('OpenAI adapter', () => {
  it('converts system, vision, tool use, and tool results with pairing preserved', async () => {
    const converted = await toOpenAIMessages(
      [
        {
          id: 'a',
          role: 'assistant',
          createdAt: 0,
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
          ],
        },
        {
          id: 'u',
          role: 'user',
          createdAt: 1,
          content: [
            {
              type: 'image',
              mime: 'image/png',
              source: { kind: 'inline', bytes: new Uint8Array([1]) },
            },
            { type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
      undefined,
      'composed',
    )
    expect(converted).toEqual([
      { role: 'system', content: 'composed' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ])
  })

  it('normalizes fragmented UTF-8, parallel tool calls, usage, and finish reason', async () => {
    const stream = [
      'data: {"id":"chat_1","choices":[{"delta":{"role":"assistant","content":"😀","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\""}},{"index":1,"id":"call_2","function":{"name":"write","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\\\":\\\"a\\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const encoded = bytes(stream)
    const split = encoded.indexOf(0xf0) + 2
    const result = await collect(
      parseOpenAISse(chunks([encoded.slice(0, split), encoded.slice(split)])),
    )
    expect(result).toContainEqual({ kind: 'message.start', messageId: 'chat_1' })
    expect(result).toContainEqual({ kind: 'text.delta', text: '😀' })
    expect(result.filter((chunk) => chunk.kind === 'tool_use.start')).toHaveLength(2)
    expect(result).toContainEqual({
      kind: 'tool_use.delta',
      id: 'call_1',
      argsFragment: 'path":"a"}',
    })
    expect(result).toContainEqual({ kind: 'usage', usage: { input: 10, output: 4, cacheRead: 2 } })
    expect(result.at(-1)).toEqual({ kind: 'message.stop', stopReason: 'tool_use' })
  })

  it('emits interrupted for abort and truncated streams, never a normal stop', async () => {
    const truncated = await collect(parseOpenAISse(chunks([bytes('data: {"id":"x"')])))
    expect(truncated.at(-1)).toMatchObject({
      kind: 'message.interrupted',
      reason: 'incomplete_sse_frame',
    })
    const controller = new AbortController()
    controller.abort()
    const aborted = await collect(
      parseOpenAISse(chunks([bytes('data: {}\n\n')]), controller.signal),
    )
    expect(aborted.at(-1)).toMatchObject({ kind: 'message.interrupted', reason: 'aborted' })
    expect(aborted.some((chunk) => chunk.kind === 'message.stop')).toBe(false)
  })

  it('maps provider errors into the shared taxonomy', () => {
    expect(mapOpenAIError(401).category).toBe('auth')
    expect(mapOpenAIError(429, { error: { code: 'insufficient_quota' } }).category).toBe('quota')
    expect(mapOpenAIError(400, { error: { code: 'context_length_exceeded' } }).category).toBe(
      'context_length',
    )
    expect(mapOpenAIError(500).retryable).toBe(true)
  })

  it('classifies transport failure and turns preflight abort into interruption', async () => {
    const failing = new OpenAIClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request: async () => Promise.reject(new Error('offline')) },
    })
    await expect(
      collect(failing.stream({ model: 'gpt', messages: [] }, new AbortController().signal)),
    ).rejects.toMatchObject({ provider: 'openai', category: 'network', retryable: true })

    const controller = new AbortController()
    controller.abort()
    expect(
      await collect(failing.stream({ model: 'gpt', messages: [] }, controller.signal)),
    ).toEqual([{ kind: 'message.interrupted', reason: 'aborted' }])
  })

  it('maps the complete request and passes credentials and AbortSignal through ports', async () => {
    const signal = new AbortController().signal
    const request = vi.fn(async (_input: HttpRequest) => ({
      status: 200,
      body: chunks([
        bytes(
          'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      ]),
    }))
    const client = new OpenAIClient({
      credentials: { getCredential: async () => 'secret' },
      http: { request },
    })
    await collect(
      client.stream(
        {
          model: 'gpt',
          messages: [],
          system: 'system',
          maxTokens: 42,
          temperature: 0.2,
          topP: 0.8,
          stopSequences: ['END'],
          responseFormat: 'json',
          toolChoice: { name: 'read' },
          tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
          rawMeta: {
            openai: { logprobs: true, seed: 7, reasoningEffort: 'high', modalities: ['text'] },
          },
        },
        signal,
      ),
    )
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      signal,
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: 'Bearer secret' },
      body: {
        model: 'gpt',
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 42,
        temperature: 0.2,
        top_p: 0.8,
        stop: ['END'],
        response_format: { type: 'json_object' },
        tool_choice: { type: 'function', function: { name: 'read' } },
        logprobs: true,
        seed: 7,
        reasoning_effort: 'high',
        modalities: ['text'],
      },
    })
  })
})
