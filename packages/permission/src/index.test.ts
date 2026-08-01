import { describe, expect, it, vi } from 'vitest'

import { PermissionManager } from './index.ts'
const req = (toolName = 'Write') => ({
  toolName,
  spec: { fs: { write: ['x'] } },
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
})
