import { describe, expect, it, vi } from 'vitest'

import { PermissionManager } from './index'
const req = (toolName = 'Write') => ({
  toolName,
  spec: { fs: { write: ['x'] } },
  input: {},
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})
const bashReq = (command: string) => ({
  toolName: 'Bash',
  spec: { bash: { command } },
  input: {},
  session: { id: 's', cwd: process.cwd() },
  attempt: 1,
})
describe('PermissionManager', () => {
  it('uses strict decision order', async () => {
    const prompt = vi.fn()
    const manager = new PermissionManager({ projectDeny: () => true, globalAllow: () => true })
    manager.setPromptHandler(prompt)
    expect((await manager.request(req())).kind).toBe('deny')
    expect(prompt).not.toHaveBeenCalled()
  })
  it('serializes prompts and caches session grants', async () => {
    let active = 0,
      max = 0
    const manager = new PermissionManager()
    manager.setPromptHandler(async () => {
      active++
      max = Math.max(max, active)
      await Promise.resolve()
      active--
      return { kind: 'allow-session' }
    })
    await Promise.all([manager.request(req()), manager.request(req('Edit'))])
    expect(max).toBe(1)
    expect((await manager.request(req())).kind).toBe('allow-session')
  })
  it('conservatively auto-allows cwd reads', async () => {
    const manager = new PermissionManager()
    expect(
      (
        await manager.request({
          toolName: 'Read',
          spec: { fs: { read: ['package.json'] } },
          input: {},
          session: { id: 's', cwd: process.cwd() },
          attempt: 1,
        })
      ).kind,
    ).toBe('allow-session')
  })
  it('keeps gh pr commands out of the silent Bash whitelist (r13-G6)', async () => {
    const prompt = vi.fn(async () => ({ kind: 'deny' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    // gh pr create/view/checks carry outbound semantics (spec §4.4 r13-G6):
    // never silently allowed, always prompt — even the read-only subcommands,
    // because SAFE_BASH only grants allow-once, looser than the spec's
    // optional allow-session for `gh pr view` / `gh pr checks`.
    for (const command of ['gh pr create', 'gh pr view 123', 'gh pr checks 123']) {
      expect((await manager.request(bashReq(command))).kind).toBe('deny')
    }
    expect(prompt).toHaveBeenCalledTimes(3)
    expect((await manager.request(bashReq('git status'))).kind).toBe('allow-once')
  })
  it('caches network grants by canonical origin, not secret-bearing paths', async () => {
    const prompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const network = (url: string) => ({
      toolName: 'WebFetch',
      spec: { net: { url, method: 'GET' as const } },
      input: { url: `${url}/path?token=secret` },
      session: { id: 's', cwd: process.cwd() },
      attempt: 1,
    })
    expect((await manager.request(network('https://example.com'))).kind).toBe('allow-session')
    expect((await manager.request(network('https://example.com/other'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect((await manager.request(network('https://other.example'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(2)
  })
  it('shares session grants across explicit default ports and non-special schemes', async () => {
    const prompt = vi.fn(async () => ({ kind: 'allow-session' as const }))
    const manager = new PermissionManager()
    manager.setPromptHandler(prompt)
    const network = (url: string) => ({
      toolName: 'WebFetch',
      spec: { net: { url, method: 'GET' as const } },
      input: {},
      session: { id: 's', cwd: process.cwd() },
      attempt: 1,
    })
    expect((await manager.request(network('https://example.com:443/a'))).kind).toBe('allow-session')
    // same origin modulo the default port → cache hit, no second prompt
    expect((await manager.request(network('https://example.com/b'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(1)
    // non-special scheme keeps its port in the origin key (URL.origin would be "null")
    expect((await manager.request(network('git://example.com:9418/x'))).kind).toBe('allow-session')
    expect((await manager.request(network('git://example.com:9418/y'))).kind).toBe('allow-session')
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})
