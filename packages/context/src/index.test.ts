import type { Message, ProviderCapabilities } from '@apollo-code/provider-kit'
import { describe, expect, it } from 'vitest'

import { SlidingWindowPolicy, SummaryPolicy } from './index'
const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  content: [{ type: 'text', text }],
  createdAt: 0,
})

describe('SummaryPolicy', () => {
  const messages = Array.from({ length: 110 }, (_, index) =>
    msg(`m${index}`, index % 2 ? 'assistant' : 'user', `turn ${index} ${'x'.repeat(30)}`),
  )
  const context = { session: { messages }, capabilities: caps, turnId: 'turn-110', model: 'main' }
  it('summarizes a 100+ message session and re-wraps the result as untrusted', async () => {
    const events: string[] = []
    const policy = new SummaryPolicy(
      { keepRecent: 10, reservedOutputTokens: 1, targetRatio: 0.5 },
      {
        provider: {
          name: 'cheap',
          capabilities: caps,
          stream: async function* () {},
          dispose: async () => {},
          complete: async () => ({
            message: msg('summary', 'assistant', 'decisions and unresolved work'),
            usage: { input: 10, output: 5 },
          }),
        },
        telemetry: (event) => {
          events.push(event.name)
        },
        now: () => new Date('2026-08-02T00:00:00Z'),
      },
    )
    const snapshot = await policy.compact(context)
    expect(snapshot.strategy).toBe('summary')
    expect(snapshot.compactedMessageIds.length).toBeGreaterThan(90)
    expect(snapshot.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('<untrusted source="summary">'),
    })
    expect(events).toEqual(['context.summary_requested'])
  })
  it.each([
    new Error('network'),
    Object.assign(new Error('rate limited'), { status: 429 }),
    'arbitrary',
  ])('falls back to sliding for %s', async (failure) => {
    const events: string[] = []
    const policy = new SummaryPolicy(
      { keepRecent: 10, reservedOutputTokens: 1 },
      {
        provider: {
          name: 'cheap',
          capabilities: caps,
          stream: async function* () {},
          dispose: async () => {},
          complete: async () => {
            throw failure
          },
        },
        telemetry: (event) => {
          events.push(event.name)
        },
      },
    )
    const snapshot = await policy.compact(context)
    expect(snapshot.strategy).toBe('sliding')
    expect(events).toEqual(['context.summary_requested', 'context.summary_failed'])
  })
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
  it('always preserves messages pinned to context', async () => {
    const pinned = { ...msg('pinned', 'user', 'x'.repeat(1000)), meta: { pinnedToContext: true } }
    const p = new SlidingWindowPolicy({ keepRecent: 1, reservedOutputTokens: 1 })
    const snapshot = await p.compact({
      session: { messages: [pinned, msg('latest', 'user', 'now')] },
      capabilities: caps,
      turnId: 't',
      model: 'm',
    })
    expect(snapshot.messages.map((message) => message.id)).toContain('pinned')
  })
})
