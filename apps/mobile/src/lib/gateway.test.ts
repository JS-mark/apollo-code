/** 网关基址解析（REM-r1 移动站独立部署）：#gw= → localStorage → 同源。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { gatewayBase, gatewayLabel, setGatewayBase } from './gateway'

const store = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}
const locationStub = { hash: '', host: 'm.example.com', protocol: 'https:' }

vi.stubGlobal('localStorage', localStorageStub)
vi.stubGlobal('window', { location: locationStub })

beforeEach(() => {
  store.clear()
  locationStub.hash = ''
})

describe('gatewayBase', () => {
  it('defaults to same-origin (empty string) when nothing is configured', () => {
    expect(gatewayBase()).toBe('')
  })

  it('parses #gw= from the pairing hash, decodes and persists it', () => {
    locationStub.hash = '#pair=ABCD2345&gw=https%3A%2F%2Fgw.example.com'
    expect(gatewayBase()).toBe('https://gw.example.com')
    expect(store.get('volund-mobile-gateway')).toBe('https://gw.example.com')
    // hash 清掉后仍从 localStorage 取
    locationStub.hash = ''
    expect(gatewayBase()).toBe('https://gw.example.com')
  })

  it('ignores a malformed #gw= and falls back to storage', () => {
    store.set('volund-mobile-gateway', 'https://stored.example.com')
    locationStub.hash = '#gw=notaurl'
    expect(gatewayBase()).toBe('https://stored.example.com')
  })

  it('strips trailing slashes', () => {
    locationStub.hash = '#gw=https://gw.example.com/'
    expect(gatewayBase()).toBe('https://gw.example.com')
  })
})

describe('setGatewayBase', () => {
  it('persists a normalized base and clears on empty input', () => {
    setGatewayBase(' https://gw.example.com/ ')
    expect(store.get('volund-mobile-gateway')).toBe('https://gw.example.com')
    setGatewayBase('')
    expect(store.get('volund-mobile-gateway')).toBeUndefined()
  })

  it('rejects non-http(s) URLs', () => {
    expect(() => setGatewayBase('gw.example.com')).toThrow(/http/)
  })
})

describe('gatewayLabel', () => {
  it('falls back to the site host when same-origin', () => {
    expect(gatewayLabel()).toBe('m.example.com')
  })

  it('shows the configured gateway without scheme', () => {
    setGatewayBase('https://gw.example.com')
    expect(gatewayLabel()).toBe('gw.example.com')
  })
})
describe('GatewayApi.deleteSession', () => {
  const token = 'tok'
  const jsonOk = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response
  const realFetch = globalThis.fetch

  afterEach(() => {
    vi.stubGlobal('fetch', realFetch)
  })

  it('posts the id and returns the parsed result', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return jsonOk({ deleted: true })
      }),
    )
    const api = new GatewayApi(token)
    await expect(api.deleteSession('sess-1')).resolves.toEqual({ deleted: true })
    expect(calls[0]?.url).toBe('/v1/sessions/delete')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ id: 'sess-1' })
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer tok' })
  })

  it('surfaces the gateway error message for non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonOk({ error: { message: 'not found' } }, 404)),
    )
    const api = new GatewayApi(token)
    await expect(api.deleteSession('sess-x')).rejects.toThrow('not found')
  })
})
