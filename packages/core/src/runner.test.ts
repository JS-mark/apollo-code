import type { ProviderChunk, ProviderClient } from '@apollo-code/provider-kit'
import type { RouterPolicy } from '@apollo-code/router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EventBus } from './event-bus.ts'
import { DefaultPromptComposer } from './prompt-composer.ts'
import { Runner } from './runner.ts'
import { createSession } from './session.ts'

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
  it('locks at first tool_use and rejects cross-provider retry without persisting partial output', async () => {
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
    const policy = router(first, async () => ({
      provider: second,
      model: 'm2',
      reason: 'fallback',
    }))
    const state = await new Runner(context(), policy, composer, tools, bus).run('hi')
    expect(events).toContain('provider_sticky_violation')
    expect(
      state.messages.some((message) =>
        message.content.some((part) => part.type === 'text' && part.text === 'partial'),
      ),
    ).toBe(false)
    expect(tools.execute).not.toHaveBeenCalled()
  })
  it('injects composed system prompt', async () => {
    const client = provider([[{ kind: 'message.stop', stopReason: 'end_turn' }]])
    const spy = vi.spyOn(client, 'stream')
    await new Runner(context(), router(client), composer, tools).run('hi')
    expect(spy.mock.calls[0]?.[0].system).toBe('<!-- source: builtin, priority: 1000 -->\nsystem')
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
    const state = await new Runner(context(), policy, composer, tools).run('hi')
    expect(policy.pick).toHaveBeenCalledTimes(1)
    expect(state.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'kept' })
  })
})
