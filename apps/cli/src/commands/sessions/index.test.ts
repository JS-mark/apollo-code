import { describe, expect, it, vi } from 'vitest'

import { createSessionsCommand } from '.'
import type { VolundPorts } from '../../ports'
import { unavailablePorts } from '../../ports'
import type { CliIo } from '../../shared/cli-types'

const nonInteractive: CliIo = {
  isInteractiveTerminal: () => false,
  readStdin: async () => '',
}

function portsWithSession(session: Record<string, unknown>): VolundPorts {
  return { ...unavailablePorts(), session } as unknown as VolundPorts
}

function run(
  args: string[],
  ports: VolundPorts,
  io: CliIo = nonInteractive,
  extra: Record<string, unknown> = {},
) {
  return createSessionsCommand(io).run({
    args: { _: ['sessions', ...args], ...extra },
    cwd: '/repo',
    ports,
  })
}

describe('volund sessions', () => {
  it('lists sessions tab-separated by default and as JSON with --json', async () => {
    const ports = portsWithSession({
      list: async () => [
        { id: 'sess-a', updatedAt: '2026-09-01T00:00:00Z', cwd: '/a', title: 'First' },
      ],
    })
    const text = await run(['list'], ports)
    expect(text.exitCode).toBe(0)
    expect(text.stdout).toBe('sess-a\t2026-09-01T00:00:00Z\t/a\tFirst\n')
    const json = await run(['list'], ports, nonInteractive, { json: true })
    expect(JSON.parse(json.stdout)).toEqual([
      { id: 'sess-a', updatedAt: '2026-09-01T00:00:00Z', cwd: '/a', title: 'First' },
    ])
  })

  it('deletes by unique prefix with --yes and reports the fresh session when active', async () => {
    const del = vi.fn(async () => ({ next: 'sess-new' }))
    const ports = portsWithSession({
      list: async () => [
        { id: 'sess-aaaa', updatedAt: 'x', cwd: '/a', title: 'Active work' },
        { id: 'other-bbbb', updatedAt: 'x', cwd: '/b', title: 'Other' },
      ],
      delete: del,
    })
    const result = await run(['delete', 'sess-aa'], ports, nonInteractive, { yes: true })
    expect(result.exitCode).toBe(0)
    expect(del).toHaveBeenCalledWith('sess-aaaa')
    expect(result.stdout).toContain('new session: sess-new')
  })

  it('requires --yes outside an interactive terminal（与 history clear 同一确认契约）', async () => {
    const ports = portsWithSession({
      list: async () => [{ id: 'sess-aaaa', updatedAt: 'x', cwd: '/a', title: 'T' }],
      delete: async () => ({}),
    })
    const result = await run(['delete', 'sess-aaaa'], ports)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/--yes/)
  })

  it('confirms via io.confirm on a TTY and aborts on decline', async () => {
    const del = vi.fn(async () => ({}))
    const ports = portsWithSession({
      list: async () => [{ id: 'sess-aaaa', updatedAt: 'x', cwd: '/a', title: 'T' }],
      delete: del,
    })
    const io: CliIo = {
      isInteractiveTerminal: () => true,
      readStdin: async () => '',
      confirm: vi.fn(async () => true),
    }
    const accepted = await run(['delete', 'sess-aaaa'], ports, io)
    expect(io.confirm).toHaveBeenCalled()
    expect(del).toHaveBeenCalledWith('sess-aaaa')
    expect(accepted.exitCode).toBe(0)

    const declining: CliIo = { ...io, confirm: vi.fn(async () => false) }
    const declined = await run(['delete', 'sess-aaaa'], ports, declining)
    expect(declined.exitCode).toBe(2)
  })

  it('distinguishes ambiguous prefixes, missing sessions, and in-flight turns', async () => {
    const ports = portsWithSession({
      list: async () => [
        { id: 'sess-aaaa', updatedAt: 'x', cwd: '/a', title: 'A' },
        { id: 'sess-aabb', updatedAt: 'x', cwd: '/b', title: 'B' },
      ],
      delete: async () => ({}),
    })
    const ambiguous = await run(['delete', 'sess-a'], ports, nonInteractive, { yes: true })
    expect(ambiguous.exitCode).toBe(2)
    expect(ambiguous.stderr).toContain('Ambiguous')

    const missingPorts = portsWithSession({
      list: async () => [],
      delete: async () => ({}),
    })
    const missing = await run(['delete', 'sess-aaaa'], missingPorts, nonInteractive, { yes: true })
    expect(missing.exitCode).toBe(3)

    const busyPorts = portsWithSession({
      list: async () => [{ id: 'sess-aaaa', updatedAt: 'x', cwd: '/a', title: 'A' }],
      delete: async () => {
        throw Object.assign(new Error('busy'), { code: 'session_turn_in_progress' })
      },
    })
    const busy = await run(['delete', 'sess-aaaa'], busyPorts, nonInteractive, { yes: true })
    expect(busy.exitCode).toBe(4)
  })

  it('fails honestly when the deletion port is not wired', async () => {
    const result = await run(['delete', 'sess-aaaa'], unavailablePorts(), nonInteractive, {
      yes: true,
    })
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('not connected')
  })
})
