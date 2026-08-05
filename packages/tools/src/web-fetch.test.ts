import { describe, expect, it, vi } from 'vitest'

import {
  canonicalWebOrigin,
  isForbiddenAddress,
  WebFetchTool,
  type WebTransportResponse,
} from './web-fetch'

const bytes = (...values: string[]): AsyncIterable<Uint8Array> =>
  (async function* () {
    for (const value of values) yield Buffer.from(value)
  })()
const response = (
  body = 'ok',
  overrides: Partial<WebTransportResponse> = {},
): WebTransportResponse => ({
  status: 200,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: bytes(body),
  ...overrides,
})
function context(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    session: { id: 'session', cwd: '/', turnId: 'turn' },
    native: { execute: async () => '' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ui: { requestInput: async () => '' },
  }
}

describe('WebFetch security boundary', () => {
  it('canonicalizes domain permission and rejects unsafe URL forms', () => {
    expect(canonicalWebOrigin('HTTPS://ExAmPle.com:443/a?token=secret#x')).toBe(
      'https://example.com',
    )
    expect(canonicalWebOrigin('https://例.example/path')).toBe('https://xn--fsq.example')
    for (const url of ['file:///etc/passwd', 'data:text/plain,x', 'javascript:alert(1)'])
      expect(() => canonicalWebOrigin(url)).toThrow('only permits')
    expect(() => canonicalWebOrigin('https://user:secret@example.com')).toThrow('credentials')
  })

  it('denies IPv4, IPv6, metadata, localhost, and mixed DNS answers', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ])
      expect(isForbiddenAddress(address), address).toBe(true)
    expect(isForbiddenAddress('93.184.216.34')).toBe(false)
    expect(isForbiddenAddress('2606:4700:4700::1111')).toBe(false)

    const transport = vi.fn(async () => response())
    const privateResult = await new WebFetchTool({
      resolver: async () => ['93.184.216.34', '127.0.0.1'],
      transport,
    }).invoke({ url: 'https://example.com' }, context())
    expect(privateResult.isError).toBe(true)
    expect(transport).not.toHaveBeenCalled()

    for (const host of ['localhost', 'metadata.google.internal', 'service.local']) {
      const result = await new WebFetchTool({
        resolver: async () => ['93.184.216.34'],
        transport,
      }).invoke({ url: `https://${host}/` }, context())
      expect(result.isError).toBe(true)
    }
  })

  it('pins a validated address and re-resolves every redirect hop', async () => {
    const resolver = vi
      .fn<(_host: string, signal: AbortSignal) => Promise<string[]>>()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['127.0.0.1'])
    const transport = vi.fn(async (_request: { address: string }) =>
      response('', { status: 302, headers: { location: '/next' }, body: bytes() }),
    )
    const result = await new WebFetchTool({ resolver, transport }).invoke(
      { url: 'https://example.com/start' },
      context(),
    )
    expect(result.isError).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]![0].address).toBe('93.184.216.34')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('enforces content type, byte, character, redirect, and rate limits', async () => {
    const resolver = async () => ['93.184.216.34']
    const binary = await new WebFetchTool({
      resolver,
      transport: async () => response('png', { headers: { 'content-type': 'image/png' } }),
    }).invoke({ url: 'https://example.com' }, context())
    expect(binary.isError).toBe(true)
    const encoded = await new WebFetchTool({
      resolver,
      transport: async () =>
        response('compressed', {
          headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
        }),
    }).invoke({ url: 'https://example.com' }, context())
    expect(encoded.isError).toBe(true)
    const oversized = await new WebFetchTool({
      resolver,
      maxBytes: 3,
      transport: async () => response('', { body: bytes('12', '34') }),
    }).invoke({ url: 'https://example.com' }, context())
    expect(oversized.isError).toBe(true)
    const truncated = await new WebFetchTool({
      resolver,
      maxCharacters: 3,
      transport: async () => response('abcdef'),
    }).invoke({ url: 'https://example.com' }, context())
    expect(truncated.content[0]?.type === 'text' && truncated.content[0].text).toContain('abc')
    expect(truncated.content[0]?.type === 'text' && truncated.content[0].text).toContain(
      'truncated',
    )
    const redirect = await new WebFetchTool({
      resolver,
      maxRedirects: 0,
      transport: async () =>
        response('', { status: 301, headers: { location: '/again' }, body: bytes() }),
    }).invoke({ url: 'https://example.com' }, context())
    expect(redirect.isError).toBe(true)
    const limited = new WebFetchTool({
      resolver,
      requestsPerMinute: 1,
      transport: async () => response(),
    })
    expect((await limited.invoke({ url: 'https://example.com/a' }, context())).isError).toBeFalsy()
    expect((await limited.invoke({ url: 'https://example.com/b' }, context())).isError).toBe(true)
  })

  it('honors cancellation and never audits query strings', async () => {
    const controller = new AbortController()
    const ctx = context(controller.signal)
    const pending = new WebFetchTool({
      resolver: async () => ['93.184.216.34'],
      transport: ({ signal }) => {
        if (signal.aborted) return Promise.reject(signal.reason)
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      },
    }).invoke({ url: 'https://example.com/path?token=super-secret' }, ctx)
    controller.abort()
    expect((await pending).isError).toBe(true)
    expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain('super-secret')

    const timedOut = await new WebFetchTool({
      timeoutMs: 5,
      resolver: () => new Promise(() => undefined),
      transport: async () => response(),
    }).invoke({ url: 'https://example.com' }, context())
    expect(timedOut.isError).toBe(true)
    expect(timedOut.content[0]?.type === 'text' && timedOut.content[0].text).toContain('timed out')
  })
})
