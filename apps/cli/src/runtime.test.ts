import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { updateSession } from '@apollo-code/core'
import type { EventBus, Runner, SessionState } from '@apollo-code/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProductionPorts, FileInputHistoryStore, RuntimeSessionPort } from './runtime'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
)

function fakeFactory(
  observe: (state: SessionState, events: EventBus) => void = () => {},
): (state: SessionState, events: EventBus) => Runner {
  return (initial, events) => {
    let state = initial
    const fake = {
      get state() {
        return state
      },
      events,
      interrupt: vi.fn(() => {
        state = updateSession(state, (draft) => {
          draft.pendingInterrupt = true
        })
      }),
      run: vi.fn(async (text: string) => {
        state = updateSession(state, (draft) => {
          draft.messages = [
            ...draft.messages,
            { id: 'user-1', role: 'user', content: [{ type: 'text', text }], createdAt: 1 },
          ]
          draft.turns = [
            ...draft.turns,
            { id: 'turn-1', startMessageId: 'user-1', status: 'streaming', parentDepth: 0 },
          ]
          draft.activeTurn = 'turn-1'
        })
        return state
      }),
    } as unknown as Runner
    observe(state, events)
    return fake
  }
}

describe('RuntimeSessionPort', () => {
  it('runs through a real session port and persists append-only snapshots', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const runtime = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await runtime.start({ cwd: process.cwd(), prompt: 'hello' })
    const lines = (await readFile(join(root, `${id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: any })
    expect(lines.map((line) => line.type)).toContain('session.started')
    expect(lines.at(-1)?.type).toBe('session.snapshot')
    expect(lines.at(-1)?.payload.messages[0].content[0].text).toBe('hello')
  })

  it('resumes the last snapshot, aborts an incomplete turn, and emits session.resumed', async () => {
    const root = await mkdtemp(join(process.cwd(), '.runtime-'))
    fixtures.push(root)
    const first = new RuntimeSessionPort(root, fakeFactory())
    const { id } = await first.start({ cwd: process.cwd(), prompt: 'unfinished' })
    let restored: SessionState | undefined
    const second = new RuntimeSessionPort(
      root,
      fakeFactory((state) => {
        restored = state
      }),
    )
    await second.resume(id)
    expect(restored?.activeTurn).toBeNull()
    expect(restored?.turns[0]?.status).toBe('aborted')
    expect(await readFile(join(root, `${id}.jsonl`), 'utf8')).toContain('session.resumed')
  })
})

describe('FileInputHistoryStore', () => {
  it('persists only safe bounded inputs and trims old entries', async () => {
    const root = await mkdtemp(join(process.cwd(), '.history-'))
    fixtures.push(root)
    const path = join(root, 'history', 'input.jsonl')
    const history = new FileInputHistoryStore(path, 1024, 3, 20)

    await history.append('')
    await history.append('hello')
    await history.append('token=secret-value')
    await history.append('x'.repeat(21))
    await history.append('one')
    await history.append('two')
    await history.append('three')

    expect(await history.list()).toEqual(['one', 'two', 'three'])
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('secret-value')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

describe('status configuration adapter', () => {
  it('persists whitelisted preferences atomically and rejects readonly state', async () => {
    const root = await mkdtemp(join(process.cwd(), '.status-'))
    fixtures.push(root)
    const ports = createProductionPorts({ apolloHome: root, version: 'test' })
    const input = { cwd: process.cwd(), sessionId: 'session-test' }
    const updated = await ports.config.updatePreference?.('notifications', true, input)
    expect(updated?.config.find((item) => item.id === 'notifications')?.value).toBe(true)
    expect(await readFile(join(root, 'config.toml'), 'utf8')).toContain('notifications = true')
    await expect(ports.config.updatePreference?.('authMethod', 'env', input)).rejects.toThrow(
      'read-only',
    )
    expect(JSON.stringify(updated)).not.toContain('sk-secret-value')
  })
})
