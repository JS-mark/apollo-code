import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from './cli'
import type { ApolloPorts } from './ports'

const fixtures: string[] = []
afterEach(async () =>
  Promise.all(fixtures.map((path) => rm(path, { force: true, recursive: true }))),
)

function ports(overrides: Partial<ApolloPorts> = {}): ApolloPorts {
  return {
    version: '0.0.0-test',
    native: {
      probe: vi.fn(async () => ({
        tier: 'full' as const,
        mechanism: 'test sandbox',
        features: { filesystem: true, network: true },
        degradationReasons: [],
      })),
      health: vi.fn(async () => ({ sandbox: true, search: false, fs: false })),
    },
    auth: {
      health: vi.fn(async () => ({
        configured: false,
        detail: 'anthropic credential unavailable',
      })),
    },
    config: { health: vi.fn(async () => ({ valid: true, detail: 'valid' })) },
    telemetry: { securityEvent: vi.fn(async () => {}) },
    confirmation: { confirmDangerousNoSandbox: vi.fn(async () => false) },
    session: {
      start: vi.fn(async () => ({ id: 'session-1' })),
      resume: vi.fn(async (id) => ({ id })),
      interrupt: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    },
    ...overrides,
  }
}

describe('runCli', () => {
  it('fails strict doctor and precisely lists unavailable integrations', async () => {
    const result = await runCli(['doctor', '--strict', '--json'], ports())
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('anthropic credential unavailable')
    expect(result.stdout).toContain('native search unavailable')
    expect(result.stdout).toContain('native fs unavailable')
  })

  it('normalizes --cwd before starting a session', async () => {
    const root = await mkdtemp(join(process.cwd(), '.cli-cwd-'))
    fixtures.push(root)
    const nested = join(root, 'nested')
    await mkdir(nested)
    const testPorts = ports()
    const result = await runCli(['chat', 'hello', '--cwd', nested], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.session.start).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: nested, prompt: 'hello' }),
    )
  })

  it('rejects dangerous mode without an explicit confirmation and emits one event', async () => {
    const testPorts = ports()
    const result = await runCli(['--dangerous-no-sandbox'], testPorts)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('I understand the risk')
    expect(testPorts.telemetry.securityEvent).toHaveBeenCalledOnce()
  })

  it('shows a red warning and records permission bypass once', async () => {
    const testPorts = ports()
    const result = await runCli(['--yolo', '--no-color'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('DANGER: PERMISSIONS DISABLED')
    expect(testPorts.telemetry.securityEvent).toHaveBeenCalledWith(
      'permissions.dangerously_skipped',
      expect.any(Object),
    )
  })

  it('exits 3 when strict sandbox receives a degraded tier', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'partial' as const,
          mechanism: 'landlock',
          features: { filesystem: true, network: false },
          degradationReasons: ['no seccomp'],
        })),
        health: vi.fn(async () => ({ sandbox: true, search: false, fs: false })),
      },
    })
    const result = await runCli(['--strict-sandbox'], testPorts)
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('Sandbox: PARTIAL')
  })

  it('never enters a none-tier session without explicit confirmation', async () => {
    const testPorts = ports({
      native: {
        probe: vi.fn(async () => ({
          tier: 'none' as const,
          mechanism: 'unavailable',
          features: { filesystem: false, network: false },
          degradationReasons: ['probe failed'],
        })),
        health: vi.fn(async () => ({ sandbox: false, search: false, fs: false })),
      },
    })
    const result = await runCli([], testPorts)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('I understand the risk')
    expect(testPorts.session.start).not.toHaveBeenCalled()
  })

  it('resumes a persisted session through the session runtime port', async () => {
    const testPorts = ports()
    const result = await runCli(['resume', 'session-42'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.session.resume).toHaveBeenCalledWith('session-42')
  })
})
