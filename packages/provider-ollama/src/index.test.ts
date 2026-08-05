import { describe, expect, it, vi } from 'vitest'

import {
  OllamaClient,
  approveOllamaEndpoint,
  isLoopbackOllamaEndpoint,
  mapOllamaError,
  normalizeOllamaEndpoint,
  parseOllamaNdjson,
  probeOllamaCapabilities,
  toOllamaMessages,
  type HttpRequest,
} from './index'

const bytes = (value: string) => new TextEncoder().encode(value)
async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield bytes(part)
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iterable) result.push(item)
  return result
}

describe('Ollama endpoint trust', () => {
  it('allows and normalizes only HTTP loopback endpoints by default', () => {
    expect(normalizeOllamaEndpoint('http://LOCALHOST:11434///')).toBe('http://localhost:11434')
    expect(isLoopbackOllamaEndpoint('http://127.0.0.1:11434')).toBe(true)
    expect(isLoopbackOllamaEndpoint('http://[::1]:11434')).toBe(true)
    expect(isLoopbackOllamaEndpoint('https://localhost:11434')).toBe(false)
    expect(() => normalizeOllamaEndpoint('http://user:secret@localhost')).toThrow('userinfo')
    expect(() => normalizeOllamaEndpoint('file:///tmp/ollama.sock')).toThrow('protocol')
  })

  it('denies remote endpoints unless an interactive, endpoint-specific approval is returned', async () => {
    const endpoint = 'https://ollama.example'
    expect(() => new OllamaClient({ http: { request: vi.fn() }, endpoint })).toThrow(
      'confirmation_required',
    )
    await expect(approveOllamaEndpoint(endpoint, { interactive: false })).rejects.toThrow(
      'non_interactive_denied',
    )
    await expect(
      approveOllamaEndpoint(endpoint, { interactive: true, confirm: async () => false }),
    ).rejects.toThrow('confirmation_required')
    const approval = (await approveOllamaEndpoint(endpoint, {
      interactive: true,
      confirm: async () => true,
    }))!
    expect(() => new OllamaClient({ http: { request: vi.fn() }, endpoint, approval })).not.toThrow()
    expect(
      () =>
        new OllamaClient({
          http: { request: vi.fn() },
          endpoint: 'https://other.example',
          approval,
        }),
    ).toThrow('confirmation_required')
  })

  it('labels remote plaintext as dangerous and denies redirects', async () => {
    const seen: unknown[] = []
    const approval = (await approveOllamaEndpoint('http://192.0.2.1:11434', {
      interactive: true,
      confirm: async (warning) => {
        seen.push(warning)
        return true
      },
    }))!
    expect(seen[0]).toMatchObject({ plaintext: true })
    const client = new OllamaClient({
      endpoint: 'http://192.0.2.1:11434',
      approval,
      http: {
        request: async () => ({
          status: 302,
          headers: { location: 'http://attacker.example' },
          body: chunks(''),
        }),
      },
    })
    await expect(
      collect(client.stream({ model: 'qwen', messages: [] }, new AbortController().signal)),
    ).rejects.toThrow('redirect_denied')
  })
})

describe('Ollama adapter', () => {
  it('maps system, tool schema, tool results, options, and Ollama raw metadata', async () => {
    const request = vi.fn(async (_input: HttpRequest) => ({
      status: 200,
      body: chunks('{"done":true,"prompt_eval_count":1,"eval_count":2}\n'),
    }))
    const client = new OllamaClient({ http: { request } })
    await collect(
      client.stream(
        {
          model: 'qwen2.5-coder',
          system: 'safe system',
          messages: [
            {
              id: 'a',
              role: 'assistant',
              createdAt: 0,
              content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }],
            },
            {
              id: 'u',
              role: 'user',
              createdAt: 1,
              content: [
                {
                  type: 'tool_result',
                  toolUseId: 'call-1',
                  content: [{ type: 'text', text: 'ok' }],
                },
              ],
            },
          ],
          tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
          maxTokens: 10,
          temperature: 0.2,
          topP: 0.9,
          stopSequences: ['END'],
          responseFormat: 'json',
          rawMeta: { ollama: { keepAlive: '5m', numCtx: 8192 } },
        },
        new AbortController().signal,
      ),
    )
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'http://127.0.0.1:11434/api/chat',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: {
        model: 'qwen2.5-coder',
        stream: true,
        format: 'json',
        keep_alive: '5m',
        messages: [
          { role: 'system', content: 'safe system' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }],
          },
          { role: 'tool', content: 'ok', tool_call_id: 'call-1' },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'read', description: 'Read', parameters: { type: 'object' } },
          },
        ],
        options: { num_predict: 10, temperature: 0.2, top_p: 0.9, stop: ['END'], num_ctx: 8192 },
      },
    })
  })

  it('normalizes fragmented UTF-8 NDJSON text, tools, usage, and stop', async () => {
    const source = [
      '{"id":"chat-1","message":{"content":"😀"},"done":false}\n',
      '{"message":{"tool_calls":[{"id":"call-1","function":{"name":"read","arguments":{"path":"a"}}}]},"done":true,"prompt_eval_count":10,"eval_count":4}\n',
    ].join('')
    const encoded = bytes(source)
    const split = encoded.indexOf(0xf0) + 2
    const result = await collect(
      parseOllamaNdjson(
        (async function* () {
          yield encoded.slice(0, split)
          yield encoded.slice(split)
        })(),
      ),
    )
    expect(result).toContainEqual({ kind: 'message.start', messageId: 'chat-1' })
    expect(result).toContainEqual({ kind: 'text.delta', text: '😀' })
    expect(result).toContainEqual({ kind: 'tool_use.start', id: 'call-1', name: 'read' })
    expect(result).toContainEqual({
      kind: 'tool_use.delta',
      id: 'call-1',
      argsFragment: '{"path":"a"}',
    })
    expect(result).toContainEqual({ kind: 'usage', usage: { input: 10, output: 4 } })
    expect(result.at(-1)).toEqual({ kind: 'message.stop', stopReason: 'tool_use' })
  })

  it('reports truncated streams and maps errors', async () => {
    expect((await collect(parseOllamaNdjson(chunks('{"message":')))).at(-1)).toMatchObject({
      kind: 'message.interrupted',
      reason: 'incomplete_ndjson_frame',
    })
    expect(mapOllamaError(404, { error: 'model not found' }).category).toBe('model_not_found')
    expect(mapOllamaError(400, { error: 'context window exceeded' }).category).toBe(
      'context_length',
    )
    expect(mapOllamaError(500).retryable).toBe(true)
  })

  it('probes version capabilities offline', async () => {
    const result = await probeOllamaCapabilities({
      request: async () => ({ status: 200, body: chunks('{"version":"0.3.12"}') }),
    })
    expect(result).toEqual({ version: '0.3.12', tools: true })
  })

  it('converts supported images and rejects unsupported MIME types', async () => {
    expect(
      await toOllamaMessages([
        {
          id: 'u',
          role: 'user',
          createdAt: 0,
          content: [
            {
              type: 'image',
              mime: 'image/png',
              source: { kind: 'inline', bytes: new Uint8Array([1]) },
            },
          ],
        },
      ]),
    ).toEqual([{ role: 'user', content: '', images: ['AQ=='] }])
    await expect(
      toOllamaMessages([
        {
          id: 'u',
          role: 'user',
          createdAt: 0,
          content: [
            {
              type: 'image',
              mime: 'image/svg+xml',
              source: { kind: 'inline', bytes: new Uint8Array([1]) },
            },
          ],
        },
      ]),
    ).rejects.toThrow('Unsupported Ollama image MIME')
  })
})
