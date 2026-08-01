import type { Message, ProviderCapabilities } from '@apollo-code/provider-kit'
import { describe, expect, it } from 'vitest'

import { SlidingWindowPolicy } from './index'
const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  content: [{ type: 'text', text }],
  createdAt: 0,
})
const caps = { maxContextTokens: 100, maxOutputTokens: 10 } as ProviderCapabilities
describe('SlidingWindowPolicy', () => {
  it('includes model in token cache key and reserves budget', () => {
    let calls = 0
    const p = new SlidingWindowPolicy(
      { reservedOutputTokens: 10 },
      {
        countTokens: (_t, m) => {
          calls++
          return m === 'a' ? 1 : 2
        },
      },
    )
    expect(p.estimateTokens('x', 'a')).toBe(1)
    expect(p.estimateTokens('x', 'b')).toBe(2)
    expect(calls).toBe(2)
  })
  it('keeps tool pairs and turn boundaries', async () => {
    const messages: Message[] = [
      msg('u0', 'user', 'x'.repeat(200)),
      {
        id: 'a0',
        role: 'assistant',
        createdAt: 0,
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
      },
      {
        id: 'r0',
        role: 'user',
        createdAt: 0,
        content: [{ type: 'tool_result', toolUseId: 't', content: [{ type: 'text', text: 'ok' }] }],
      },
      msg('a1', 'assistant', 'done'),
    ]
    const p = new SlidingWindowPolicy({ keepRecent: 1, reservedOutputTokens: 1, targetRatio: 0.5 })
    const snap = await p.compact({
      session: { messages },
      capabilities: caps,
      turnId: 't',
      model: 'm',
    })
    const ids = new Set(snap.messages.map((m) => m.id))
    expect(ids.has('a0')).toBe(ids.has('r0'))
  })
  it('respects preCompact veto', async () => {
    const messages = [msg('u', 'user', 'x'.repeat(1000))]
    const p = new SlidingWindowPolicy({}, undefined, { preCompact: () => false })
    expect(
      (await p.compact({ session: { messages }, capabilities: caps, turnId: 't', model: 'm' }))
        .hookIntercepted,
    ).toBe(true)
  })
})
