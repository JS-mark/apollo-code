import { describe, expect, it } from 'vitest'

import { InvalidNetUrlError, normalizeOrigin } from './net-origin'

/** Spec §4.4 「net 匹配粒度 = origin」(r13-D1)：key 按 scheme://host[:port] 归一。 */
describe('normalizeOrigin', () => {
  it('reduces a URL to scheme://host, dropping path/query/fragment', () => {
    expect(normalizeOrigin('https://example.com/some/deep/path?query=1#frag')).toBe(
      'https://example.com',
    )
  })
  it('drops default ports for special schemes', () => {
    expect(normalizeOrigin('https://example.com:443/a')).toBe('https://example.com')
    expect(normalizeOrigin('http://example.com:80/a')).toBe('http://example.com')
    expect(normalizeOrigin('ws://example.com:80/a')).toBe('ws://example.com')
  })
  it('keeps non-default ports', () => {
    expect(normalizeOrigin('https://example.com:8443/a')).toBe('https://example.com:8443')
    expect(normalizeOrigin('http://example.com:8080/a')).toBe('http://example.com:8080')
  })
  it('lowercases scheme and host (same key regardless of casing)', () => {
    expect(normalizeOrigin('HTTPS://EXAMPLE.COM/a')).toBe('https://example.com')
  })
  it('supports non-special schemes where WHATWG URL.origin would be "null"', () => {
    expect(normalizeOrigin('git://example.com:9418/repo.git')).toBe('git://example.com:9418')
    expect(normalizeOrigin('git://example.com/repo.git')).toBe('git://example.com')
  })
  it('drops userinfo credentials from the origin', () => {
    expect(normalizeOrigin('https://user:secret@example.com/a')).toBe('https://example.com')
  })
  it('preserves IPv6 host brackets', () => {
    expect(normalizeOrigin('http://[::1]:8080/a')).toBe('http://[::1]:8080')
    expect(normalizeOrigin('http://[::1]/a')).toBe('http://[::1]')
  })
  it('rejects URLs without a usable host', () => {
    expect(() => normalizeOrigin('mailto:someone@example.com')).toThrow(InvalidNetUrlError)
    expect(() => normalizeOrigin('file:///tmp/secret')).toThrow(InvalidNetUrlError)
  })
  it('rejects unparseable URLs', () => {
    expect(() => normalizeOrigin('not a url')).toThrow(InvalidNetUrlError)
    expect(() => normalizeOrigin('')).toThrow(InvalidNetUrlError)
  })
})
