import type { ProviderChunk, ProviderClient } from '@apollo-code/provider-kit'
import type { RouterPolicy } from '@apollo-code/router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from './event-bus'
import { DefaultPromptComposer } from './prompt-composer'
import { messagesForCapabilities, Runner } from './runner'
import { createSession } from './session'

function provider(streams: ProviderChunk[][], name = 'p'): ProviderClient {
  return {
    name,
    capabilities: {
      maxContextTokens: 1,
      maxOutputTokens: 1,
      toolUse: 'parallel',
      toolResultSchema: 'anthropic',
      vision: false,
      files: false,
      thinking: false,
      streaming: true,
      streamingReasoning: false,
      cache: 'none',
      jsonMode: false,
      structuredOutput: false,
      systemPromptLocation: 'system-field',
      toolChoiceRequired: false,
      interleavedThinking: false,
    },
    async *stream(_request, signal) {
      const chunks = streams.shift() ?? []
      for (const chunk of chunks) {
        if (signal.aborted) return
        yield chunk
      }
    },
    async dispose() {},
  }
}
const context = () =>
  createSession({ id: 's', cwd: '/repo', maxTokens: 100, toolRegistrySnapshot: '' })
const tools = {
  schemas: () => [],
  execute: vi.fn(async (tool) => ({
    toolUseId: tool.id,
    content: [{ type: 'text' as const, text: 'ok' }],
  })),
}
const composer = new DefaultPromptComposer()
composer.register({ id: 'x', source: 'builtin', priority: 1000, text: 'system' })
function router(
  client: ProviderClient,
  onError: RouterPolicy['onError'] = async () => 'give-up',
): RouterPolicy {
  return {
    name: 'r',
    pick: vi.fn(async () => ({ provider: client, model: 'm', reason: 'test' })),
    onError,
  }
}

describe('Runner', () => {
  it('accepts referenced images and degrades them for providers without vision', () => {
    const messages = [
      {
        id: 'u',
        role: 'user' as const,
        createdAt: 0,
        content: [
          {
            type: 'image' as const,
            mime: 'image/png',
            source: { kind: 'handle' as const, handle: 'h' },
          },
        ],
      },
    ]
    const mapped = messagesForCapabilities(messages, 'text-only', {
      ...provider([]).capabilities,
      vision: false,
    })
    expect(mapped[0]?.content).toEqual([
      {
        type: 'text',
        text: '[Attachment omitted: provider text-only does not support vision (image/png)]',
      },
    ])
  })
  beforeEach(() => {
    tools.execute.mockClear()
  })
  it('limits tool loops to 25', async () => {
    const toolStream: ProviderChunk[] = [
      { kind: 'tool_use.start', id: 'id', name: 'x' },
      { kind: 'tool_use.delta', id: 'id', argsFragment: '{}' },
      { kind: 'tool_use.end', id: 'id' },
      { kind: 'message.stop', stopReason: 'tool_use' },
    ]
    const client = provider(Array.from({ length: 25 }, () => toolStream))
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') events.push((event.payload as { code: string }).code)
    })
    await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(25)
    expect(events).toContain('tool_loop_exhausted')
  })
  it('enforces a subagent token budget between loops and preserves partial output', async () => {
    const client = provider([
      [
        { kind: 'text.delta', text: 'partial answer' },
        { kind: 'usage', usage: { input: 4, output: 6, costUSD: 0.01 } },
        { kind: 'tool_use.start', id: 'id', name: 'x' },
        { kind: 'tool_use.delta', id: 'id', argsFragment: '{}' },
        { kind: 'tool_use.end', id: 'id' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
    ])
    const state = context()
    state.resourceBudget = { tokenMax: 10 }
    const raised: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') raised.push(event.payload)
    })
    const final = await new Runner(state, router(client), composer, tools, bus).run('hi')
    expect(final.cumulativeUsage).toMatchObject({ input: 4, output: 6, costUSD: 0.01 })
    expect(final.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([{ type: 'text', text: 'partial answer' }]),
      }),
    )
    expect(raised).toContainEqual(
      expect.objectContaining({ code: 'subagent_budget_exhausted', dimension: 'token' }),
    )
    expect(final.turns.at(-1)?.status).toBe('aborted')
  })
  it('propagates abort to provider stream', async () => {
    let seen: AbortSignal | undefined
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const client = provider([])
    client.stream = async function* (_request, signal) {
      seen = signal
      ready()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
    }
    const runner = new Runner(context(), router(client), composer, tools)
    const running = runner.run('hi')
    await started
    runner.interrupt()
    await running
    expect(seen?.aborted).toBe(true)
  })
  it('settles the turn when a provider stream throws', async () => {
    const client = provider([])
    client.stream = async function* () {
      throw new Error('provider failed')
    }
    const raised: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') raised.push(event.payload)
    })
    const state = await new Runner(context(), router(client), composer, tools, bus).run('hi')
    expect(state.activeTurn).toBeNull()
    expect(state.turns.at(-1)?.status).toBe('aborted')
    expect(raised).toContainEqual(
      expect.objectContaining({ code: 'runner_error', message: 'provider failed' }),
    )
  })
  it('fails closed on partial tool_use without consulting retry routing or executing it', async () => {
    const first = provider(
      [
        [
          { kind: 'text.delta', text: 'partial' },
          { kind: 'tool_use.start', id: 'id', name: 'x' },
          { kind: 'message.interrupted', reason: 'rst' },
        ],
      ],
      'first',
    )
    const second = provider([], 'second')
    const events: string[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'error.raised') events.push((event.payload as { code: string }).code)
    })
    const retry = vi.fn(async () => ({
      provider: second,
      model: 'm2',
      reason: 'fallback',
    }))
    const policy = router(first, retry)
    const state = await new Runner(context(), policy, composer, tools, bus).run('hi')
    expect(events).toContain('stream_resume_unsafe_partial_tool_use')
    expect(retry).not.toHaveBeenCalled()
    expect(
      state.messages.some((message) =>
        message.content.some((part) => part.type === 'text' && part.text === 'partial'),
      ),
    ).toBe(false)
    expect(tools.execute).not.toHaveBeenCalled()
  })
  it('does not replay a completed side-effect tool when the following stream is retried', async () => {
    const client = provider([
      [
        { kind: 'tool_use.start', id: 'side-effect-1', name: 'write' },
        { kind: 'tool_use.delta', id: 'side-effect-1', argsFragment: '{"value":1}' },
        { kind: 'tool_use.end', id: 'side-effect-1' },
        { kind: 'message.stop', stopReason: 'tool_use' },
      ],
      [
        { kind: 'text.delta', text: 'discarded' },
        { kind: 'message.interrupted', reason: 'rst' },
      ],
      [
        { kind: 'text.delta', text: 'done' },
        { kind: 'message.stop', stopReason: 'end_turn' },
      ],
    ])
    const policy = router(client, async () => ({ provider: client, model: 'm', reason: 'retry' }))
    const state = await new Runner(context(), policy, composer, tools).run('hi')
    expect(tools.execute).toHaveBeenCalledTimes(1)
    expect(tools.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'side-effect-1' }),
      expect.any(AbortSignal),
    )
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'done' })
  })
  it('injects composed system prompt', async () => {
    const client = provider([[{ kind: 'message.stop', stopReason: 'end_turn' }]])
    const spy = vi.spyOn(client, 'stream')
    const state = await new Runner(context(), router(client), composer, tools).run('hi')
    expect(spy.mock.calls[0]?.[0].system).toBe('<!-- source: builtin, priority: 1000 -->\nsystem')
    expect(state.systemPromptSnapshot).toBe('<!-- source: builtin, priority: 1000 -->\nsystem')
  })
  it('uses the router retry decision before sticky lock without picking again', async () => {
    const first = provider(
      [
        [
          { kind: 'text.delta', text: 'discard' },
          { kind: 'message.interrupted', reason: 'rst' },
        ],
      ],
      'first',
    )
    const second = provider(
      [
        [
          { kind: 'text.delta', text: 'kept' },
          { kind: 'message.stop', stopReason: 'end_turn' },
        ],
      ],
      'second',
    )
    const policy = router(first, async () => ({
      provider: second,
      model: 'm2',
      reason: 'fallback',
    }))
    const switched: unknown[] = []
    const bus = new EventBus()
    bus.subscribe((event) => {
      if (event.type === 'router.switched') switched.push(event.payload)
    })
    const state = await new Runner(context(), policy, composer, tools, bus).run('hi')
    expect(policy.pick).toHaveBeenCalledTimes(1)
    expect(switched).toContainEqual({
      from: 'first',
      to: 'second',
      reason: 'fallback',
      category: 'stream_truncated',
    })
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'kept' })
  })

  it('derives role hints from built-in subagent types while preserving explicit hints', async () => {
    const client = provider([
      [{ kind: 'message.stop', stopReason: 'end_turn' }],
      [{ kind: 'message.stop', stopReason: 'end_turn' }],
    ])
    const policy = router(client)
    const state = context()
    state.lineage = { depth: 1, agentType: 'planner' }
    const runner = new Runner(state, policy, composer, tools)
    await runner.run('plan')
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), { role: 'planner' })
    await runner.run('review', { role: 'reviewer', costPreference: 'quality' })
    expect(policy.pick).toHaveBeenLastCalledWith(expect.anything(), {
      role: 'reviewer',
      costPreference: 'quality',
    })
  })
})
