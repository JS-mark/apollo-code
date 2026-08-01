import { describe, expect, it, vi } from 'vitest'

import { AuthManager, MemoryCredentialStore } from './index'
describe('AuthManager', () => {
  it('resolves keychain before env without leaking payload', async () => {
    const store = new MemoryCredentialStore()
    await store.set('anthropic', 'secret')
    const emit = vi.fn(async () => {}),
      auth = new AuthManager({
        keychain: store,
        env: { ANTHROPIC_API_KEY: 'env' },
        telemetry: { emit },
      })
    expect(await auth.getCredential('anthropic')).toBe('secret')
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret')
  })
  it('verifies before storing', async () => {
    const store = new MemoryCredentialStore(),
      auth = new AuthManager({ keychain: store, telemetry: { emit: async () => {} } })
    await expect(auth.login('x', 'secret', async () => false)).rejects.toThrow()
    expect(await store.get('x')).toBeUndefined()
  })
})
