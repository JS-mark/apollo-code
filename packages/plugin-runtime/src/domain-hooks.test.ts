import type { PluginManifest } from '@apollo-code/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BridgeRuntime,
  BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
  HOOK_HANDLER_TIMEOUT_MS,
  truncateHookPayload,
  type BridgeHost,
  type HookPipelineSignal,
} from './index'

const manifest: PluginManifest = {
  name: 'apollo-plugin-git-helper',
  version: '1.0.0',
  engines: { apollo: '0.1.0' },
  main: 'index.js',
  type: 'module',
  permissions: { apollo: ['hooks.on'] },
}

function stubHost(log: (level: string, message: string) => void = () => {}): BridgeHost {
  return {
    session: {
      id: 's',
      cwd: process.cwd(),
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    register: () => ({ dispose() {} }),
    fs: {
      readFile: async () => '',
      writeFile: async () => {},
      exists: async () => false,
      glob: async () => [],
      stat: async () => ({}),
    },
    exec: async () => ({}),
    fetch: async () => ({}),
    ui: () => undefined,
    storage: async () => undefined,
    config: () => undefined,
    log,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('domain-aware hook dispatch (r13-I10, REM-52)', () => {
  it('fail-closes when a builtin hook exceeds the handler timeout', async () => {
    vi.useFakeTimers()
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'preToolUse', () => new Promise(() => {}))
    const signals: HookPipelineSignal[] = []
    const pending = runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash', input: { command: 'ls' } },
      { report: (signal) => signals.push(signal) },
    )
    await vi.advanceTimersByTimeAsync(HOOK_HANDLER_TIMEOUT_MS)
    const outcome = await pending
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('builtin')
    expect(outcome?.reason).toContain('fail-closed')
    expect(signals.map((signal) => signal.code)).toEqual(['builtin_hook_timeout'])
    expect(signals[0]).toMatchObject({
      kind: 'builtin_hook_timeout',
      domain: 'builtin',
      hook: 'apollo.builtin',
      event: 'preToolUse',
      timeoutMs: HOOK_HANDLER_TIMEOUT_MS,
    })
  })

  it('skips a timed-out plugin hook, warns, and continues the pipeline (fail-open)', async () => {
    vi.useFakeTimers()
    const warnings: string[] = []
    const runtime = new BridgeRuntime(
      stubHost((level, message) => {
        if (level === 'warn') warnings.push(message)
      }),
    )
    const seen: string[] = []
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => new Promise(() => {}), { priority: 5 })
    runtime.registerHostHook('builtin', 'preToolUse', () => {
      seen.push('builtin')
    })
    const signals: HookPipelineSignal[] = []
    const pending = runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash', input: { command: 'ls' } },
      { report: (signal) => signals.push(signal) },
    )
    await vi.advanceTimersByTimeAsync(HOOK_HANDLER_TIMEOUT_MS + 1_000)
    const outcome = await pending
    expect(outcome?.veto).toBeUndefined()
    expect(seen).toEqual(['builtin'])
    expect(signals.map((signal) => signal.code)).toEqual(['hook_skipped'])
    expect(signals[0]).toMatchObject({
      kind: 'hook_skipped',
      domain: 'plugin',
      hook: manifest.name,
      cause: 'timeout',
    })
  })

  it('fail-closes when a builtin hook throws', async () => {
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'postToolUse', () => {
      throw new Error('scanner crashed')
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'postToolUse',
      { tool: 'Read' },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome?.veto).toBe(true)
    expect(outcome?.reason).toContain('fail-closed')
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'builtin_hook_error',
        code: 'builtin_hook_error',
        hook: 'apollo.builtin',
        message: 'scanner crashed',
      }),
    ])
  })

  it('skips a throwing plugin hook and lets later handlers decide', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on(
      'preToolUse',
      () => {
        throw new Error('boom')
      },
      { priority: 5 },
    )
    bridge.hooks.on('preToolUse', () => ({ veto: true, reason: 'later hook wins' }), {
      priority: 1,
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'preToolUse',
      { tool: 'Bash' },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome).toEqual({ veto: true, reason: 'later hook wins' })
    expect(signals).toEqual([
      expect.objectContaining({ kind: 'hook_skipped', domain: 'plugin', cause: 'error' }),
    ])
  })

  it('runs the builtin domain before plugin hooks regardless of registration order', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const calls: string[] = []
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    bridge.hooks.on('preToolUse', () => {
      calls.push('plugin')
    })
    runtime.registerHostHook('builtin', 'preToolUse', () => {
      calls.push('builtin')
      return { veto: true, reason: 'blocked by apollo.secret-scan' }
    })
    const outcome = await runtime.runDomainHooks('preToolUse', { tool: 'Bash' })
    expect(outcome).toEqual({ veto: true, reason: 'blocked by apollo.secret-scan' })
    expect(calls).toEqual(['builtin'])
  })

  it('feeds each handler the previous handler output (serial pipeline, 06b §6.11.1)', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const bridge = runtime.create(manifest, process.cwd(), 'tool-1')
    const seen: unknown[] = []
    bridge.hooks.on(
      'preToolUse',
      (payload) => {
        const current = payload as { tool: string; input: unknown }
        return { value: { ...current, input: { command: 'echo one' } } }
      },
      { priority: 10 },
    )
    bridge.hooks.on(
      'preToolUse',
      (payload) => {
        seen.push(payload)
        const current = payload as { tool: string; input: unknown }
        return { value: { ...current, input: { command: 'echo two' } } }
      },
      { priority: 5 },
    )
    const outcome = await runtime.runDomainHooks('preToolUse', {
      tool: 'Bash',
      input: { command: 'rm -rf /' },
    })
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'echo one' } }])
    expect(outcome).toEqual({ value: { tool: 'Bash', input: { command: 'echo two' } } })
  })

  it('enforces per-domain priority bands for host hooks', () => {
    const runtime = new BridgeRuntime(stubHost())
    expect(() =>
      runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 899 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() =>
      runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 1001 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() =>
      runtime.registerHostHook('project', 'preToolUse', () => {}, { priority: 900 }),
    ).toThrow('plugin_hook_priority_invalid')
    expect(() => runtime.registerHostHook('user', 'preToolUse', () => {}, { priority: 0 })).toThrow(
      'plugin_hook_priority_invalid',
    )
    runtime.registerHostHook('builtin', 'preToolUse', () => {}, { priority: 1000 })
    runtime.registerHostHook('project', 'preToolUse', () => {}, { priority: 500 })
    runtime.registerHostHook('user', 'preToolUse', () => {}, { priority: -1000 })
    runtime.registerHostHook('builtin', 'preToolUse', () => {})
  })

  it('truncates builtin payloads over 1MB before the handler sees them', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const seen: unknown[] = []
    runtime.registerHostHook('builtin', 'preToolUse', (payload) => {
      seen.push(payload)
    })
    const signals: HookPipelineSignal[] = []
    const outcome = await runtime.runDomainHooks(
      'preToolUse',
      {
        tool: 'Write',
        input: { path: 'a.txt', content: 'x'.repeat(2 * BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES) },
      },
      { report: (signal) => signals.push(signal) },
    )
    expect(outcome?.veto).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(seen[0]))).toBeLessThanOrEqual(
      BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
    )
    expect((seen[0] as { input: { content: string } }).input.content).toContain('truncated')
    expect(signals).toEqual([
      expect.objectContaining({
        kind: 'hook_payload_truncated',
        code: 'hook_payload_truncated',
        limitBytes: BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
      }),
    ])
    expect((signals[0] as { truncatedBytes: number }).truncatedBytes).toBeGreaterThan(0)
  })

  it('leaves small builtin payloads untouched', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const seen: unknown[] = []
    const signals: HookPipelineSignal[] = []
    runtime.registerHostHook('builtin', 'preToolUse', (payload) => {
      seen.push(payload)
    })
    const payload = { tool: 'Bash', input: { command: 'ls' } }
    await runtime.runDomainHooks('preToolUse', payload, {
      report: (signal) => signals.push(signal),
    })
    expect(seen).toEqual([payload])
    expect(signals).toEqual([])
  })

  it('removes host hooks on dispose', async () => {
    const runtime = new BridgeRuntime(stubHost())
    const disposable = runtime.registerHostHook('builtin', 'preToolUse', () => ({
      veto: true,
      reason: 'gone soon',
    }))
    await disposable.dispose()
    expect(await runtime.runDomainHooks('preToolUse', {})).toBeUndefined()
  })

  it('funnels memory events through runMemoryHooks instead of the domain pipeline', async () => {
    const runtime = new BridgeRuntime(stubHost())
    runtime.registerHostHook('builtin', 'memory.preWrite', () => {})
    await expect(runtime.runDomainHooks('memory.preWrite', {})).rejects.toThrow(
      'plugin_memory_hook_dispatch_required',
    )
  })
})

describe('truncateHookPayload', () => {
  it('returns the original value when under the limit', () => {
    const value = { a: 'small' }
    expect(truncateHookPayload(value, 1024)).toEqual({ value, truncatedBytes: 0 })
  })

  it('hard-caps pathological payloads that string shrinking cannot fit', () => {
    const value = Array.from({ length: 100_000 }, (_, index) => ({ k: index }))
    const gate = truncateHookPayload(value, 2048)
    expect(Buffer.byteLength(JSON.stringify(gate.value))).toBeLessThanOrEqual(2048)
    expect(gate.truncatedBytes).toBeGreaterThan(0)
  })
})
