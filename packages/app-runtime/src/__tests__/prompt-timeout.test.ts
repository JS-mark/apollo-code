import { PermissionManager } from '@volund/permission'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AskPromptController,
  DEFAULT_PROMPT_TIMEOUT_MS,
  PermissionPromptController,
  type InteractivePermissionRequest,
} from '../contracts'

const permissionRequest = (id: string): InteractivePermissionRequest => ({
  display: { approvable: true, spec: '{}', toolName: 'Bash' },
  id,
  attempt: 0,
  input: {},
  spec: {},
  toolName: 'Bash',
})

describe('PermissionPromptController 无人决策超时', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('到点自动 deny（reason=timeout）并全端清卡', async () => {
    const prompts = new PermissionPromptController()
    const seen: number[] = []
    prompts.subscribe((requests) => seen.push(requests.length))
    const decision = prompts.request(permissionRequest('r1'))
    expect(seen.at(-1)).toBe(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_PROMPT_TIMEOUT_MS - 1)
    expect(seen.at(-1)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(decision).resolves.toEqual({ kind: 'deny', reason: 'timeout' })
    expect(seen.at(-1)).toBe(0)
  })

  it('默认 120s；0 关闭兜底；configure 只影响其后入队的卡', async () => {
    const off = new PermissionPromptController({ timeoutMs: 0 })
    const never = off.request(permissionRequest('r1'))
    await vi.advanceTimersByTimeAsync(DEFAULT_PROMPT_TIMEOUT_MS * 2)
    expect(off.requests()).toHaveLength(1)
    off.decide('r1', { kind: 'allow-once' })
    await expect(never).resolves.toEqual({ kind: 'allow-once' })

    const prompts = new PermissionPromptController({ timeoutMs: 5_000 })
    prompts.configure({ timeoutMs: 50 })
    const fast = prompts.request(permissionRequest('r2'))
    await vi.advanceTimersByTimeAsync(50)
    await expect(fast).resolves.toEqual({ kind: 'deny', reason: 'timeout' })
  })

  it('用户先决策则兜底钟拆除，不产生二次 settle', async () => {
    const prompts = new PermissionPromptController({ timeoutMs: 1_000 })
    const decision = prompts.request(permissionRequest('r1'))
    prompts.decide('r1', { kind: 'allow-project' })
    await expect(decision).resolves.toEqual({ kind: 'allow-project' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(prompts.requests()).toHaveLength(0)
  })

  it('超时 deny 沿权限链给出 permission_timeout 带码文案', async () => {
    const prompts = new PermissionPromptController({ timeoutMs: 10 })
    const manager = new PermissionManager()
    manager.setPromptHandler((request) =>
      prompts.request({
        display: { approvable: true, spec: '{}', toolName: request.toolName },
        id: 'pending',
        attempt: request.attempt,
        input: request.input,
        spec: request.spec,
        toolName: request.toolName,
      }),
    )
    const failure = manager
      .requestAndExecute(
        {
          toolName: 'Bash',
          spec: { bash: { command: 'sleep' } },
          input: {},
          session: { id: 's', cwd: process.cwd() },
          attempt: 0,
        },
        async () => 'ok',
      )
      .catch((error: Error & { code?: string }) => error.code ?? error.message)
    await vi.advanceTimersByTimeAsync(10)
    await expect(failure).resolves.toBe('permission_timeout')
  })
})

describe('AskPromptController 无人作答超时', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('到点自动关闭（undefined）并记入 timedOut 供 ask_timeout 消费', async () => {
    const asks = new AskPromptController({ timeoutMs: 100 })
    const answer = asks.request({ id: 'a1', question: '?', options: [] })
    expect(asks.consumeTimedOut('a1')).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await expect(answer).resolves.toBeUndefined()
    expect(asks.requests()).toHaveLength(0)
    expect(asks.consumeTimedOut('a1')).toBe(true)
    expect(asks.consumeTimedOut('a1')).toBe(false)
  })

  it('正常作答拆除兜底钟', async () => {
    const asks = new AskPromptController({ timeoutMs: 100 })
    const answer = asks.request({ id: 'a1', question: '?', options: [] })
    asks.decide('a1', 'choice')
    await expect(answer).resolves.toBe('choice')
    await vi.advanceTimersByTimeAsync(200)
    expect(asks.consumeTimedOut('a1')).toBe(false)
  })
})
