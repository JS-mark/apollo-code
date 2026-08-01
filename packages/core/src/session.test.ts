import { describe, expect, it } from 'vitest'
import { createSession, updateSession } from './session.js'

describe('SessionState', () => {
  it('updates immutably and increments version', () => {
    const original = createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: 'tools-1' })
    const updated = updateSession(original, draft => { draft.pendingInterrupt = true })
    expect(original.pendingInterrupt).toBe(false); expect(updated.pendingInterrupt).toBe(true); expect(updated.version).toBe(1)
  })
  it('does not persist a permission cache in SessionState', () => { expect(createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: 'tools-1' })).not.toHaveProperty('permissionCache') })
})
