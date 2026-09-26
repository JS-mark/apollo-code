/** 网关基址解析（REM-r1 移动站独立部署）：#gw= → localStorage → 同源。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { gatewayBase, gatewayLabel, GatewayApi, GatewayWs, setGatewayBase } from './gateway'

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

/** 可控的假 WebSocket：实例表驱动 onopen/onclose；发帧只记录不传输。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | undefined
  onclose: ((event: { code: number; reason: string }) => void) | undefined
  onerror: (() => void) | undefined
  onmessage: ((event: { data: unknown }) => void) | undefined

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000, reason: '' })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

const noopHandlers = {
  onOpenChange: () => {},
  onHello: () => {},
  onEvent: () => {},
  onFrame: () => {},
}

describe('GatewayWs 出站队列（断线丢帧修复）', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  it('queues frames while disconnected and flushes them in order on reconnect', () => {
    const ws = new GatewayWs('tok', noopHandlers)
    ws.connect()
    const first = FakeWebSocket.instances[0]!
    // 连接尚未 open 就发送：帧进站而非丢失。
    ws.send({ type: 'session.resume', id: 'sess-1', ref: 'r1' })
    expect(first.sent).toEqual([])
    first.open()
    expect(first.sent).toHaveLength(1)
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ type: 'session.resume', id: 'sess-1' })

    // 断线窗口再发一帧；重连成功后按序补发。
    first.drop()
    ws.send({ type: 'turn.submit', prompt: 'hello', ref: 't1' })
    vi.advanceTimersByTime(2_500)
    const second = FakeWebSocket.instances[1]!
    expect(second).toBeDefined()
    second.open()
    expect(second.sent).toHaveLength(1)
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: 'turn.submit', prompt: 'hello' })
    ws.close()
  })

  it('caps the outbox and drops the oldest frames first', () => {
    const ws = new GatewayWs('tok', noopHandlers)
    ws.connect()
    // 不 open：全部入队。
    for (let i = 0; i < 70; i++) ws.send({ type: 'ping', ref: `p${i}` })
    const first = FakeWebSocket.instances[0]!
    first.open()
    expect(first.sent).toHaveLength(64)
    // 最旧的 6 条（p0..p5）被丢弃，队首是 p6。
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ ref: 'p6' })
    expect(JSON.parse(first.sent[63]!)).toMatchObject({ ref: 'p69' })
    ws.close()
  })

  it('send after close() is a no-op (no outbox growth)', () => {
    const ws = new GatewayWs('tok', noopHandlers)
    ws.connect()
    ws.close()
    ws.send({ type: 'ping' })
    expect(FakeWebSocket.instances[0]!.sent).toEqual([])
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
