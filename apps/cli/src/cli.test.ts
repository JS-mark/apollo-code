import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from './cli'
import { command } from './command'
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
      login: vi.fn(async () => ({ detail: 'anthropic credential stored in encrypted file' })),
      logout: vi.fn(async () => ({ detail: 'anthropic credential removed' })),
    },
    config: { health: vi.fn(async () => ({ valid: true, detail: 'valid' })) },
    telemetry: {
      securityEvent: vi.fn(async () => {}),
      summary: vi.fn(async () => ({
        samples: 0,
        corruptLines: 0,
        tiers: {},
        escape: { allow: 0, deny: 0, ratio: null },
        probe: null,
      })),
      export: vi.fn(async () => 0),
      clear: vi.fn(async () => {}),
      health: vi.fn(async () => ({
        exists: false,
        writable: true,
        corruptLines: 0,
        samples: 0,
        detail: 'local sink not created yet',
      })),
    },
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
  it('declares the implemented command surface', () => {
    expect(Object.keys(command.subCommands ?? {})).toEqual([
      'chat',
      'resume',
      'restore',
      'login',
      'logout',
      'config',
      'history',
      'context',
      'evolution',
      'plugin',
      'telemetry',
      'doctor',
      'hook',
      'mcp',
      'version',
      'help',
    ])
  })

  it('installs, lists, diagnoses, disables, and uninstalls plugins through one port', async () => {
    const plugin = {
      install: vi.fn(async () => ({ name: 'apollo-plugin-demo', version: '1.0.0' })),
      uninstall: vi.fn(async () => {}),
      list: vi.fn(async () => ({
        'apollo-plugin-demo': { version: '1.0.0', enabled: true },
      })),
      setEnabled: vi.fn(async () => {}),
      doctor: vi.fn(async () => ({
        name: 'apollo-plugin-demo',
        version: '1.0.0',
        permissions: ['tools.register'],
      })),
    }
    expect((await runCli(['plugin', 'install', './demo'], ports({ plugin }))).stdout).toContain(
      'Installed apollo-plugin-demo@1.0.0',
    )
    expect((await runCli(['plugin', 'list', '--json'], ports({ plugin }))).stdout).toContain(
      'apollo-plugin-demo',
    )
    expect(
      (await runCli(['plugin', 'doctor', 'apollo-plugin-demo'], ports({ plugin }))).stdout,
    ).toContain('tools.register')
    await runCli(['plugin', 'disable', 'apollo-plugin-demo'], ports({ plugin }))
    await runCli(['plugin', 'uninstall', 'apollo-plugin-demo'], ports({ plugin }))
    expect(plugin.setEnabled).toHaveBeenCalledWith('apollo-plugin-demo', false)
    expect(plugin.uninstall).toHaveBeenCalledWith('apollo-plugin-demo')
  })

  it('lists and inspects MCP servers without exposing URL credentials', async () => {
    const mcp = {
      list: vi.fn(async () => [
        { name: 'demo', transport: 'https://user:secret@example.test/sse' },
      ]),
      test: vi.fn(async () => ({ protocolVersion: '2025-03-26' })),
      inspect: vi.fn(async () => ({ tools: [{ name: 'read', description: 'reads' }] })),
    }
    const listed = await runCli(['mcp', 'list'], ports({ mcp }))
    expect(listed.stdout).toContain('demo')
    expect(listed.stdout).not.toContain('secret')
    expect((await runCli(['mcp', 'test', 'demo'], ports({ mcp }))).stdout).toContain('2025-03-26')
    expect((await runCli(['mcp', 'inspect', 'demo'], ports({ mcp }))).stdout).toContain(
      'read — reads',
    )
  })

  it('shows and rolls back evolution audit records through one port', async () => {
    const evolution = {
      show: vi.fn(async () => [{ namespace: 'context', param: 'target_ratio' }]),
      rollback: vi.fn(async () => [{ param: 'target_ratio' }]),
    }
    const shown = await runCli(
      ['evolution', 'show', '--namespace', 'context', '--json'],
      ports({ evolution }),
    )
    expect(shown.stdout).toContain('target_ratio')
    const rolled = await runCli(
      ['evolution', 'rollback', '--namespace', 'context'],
      ports({ evolution }),
    )
    expect(rolled.stdout).toContain('1 parameter')
    expect(evolution.rollback).toHaveBeenCalledWith({ namespace: 'context' })
  })

  it('exposes context show, keep, compact and policy control through one port', async () => {
    const context = {
      show: vi.fn(async () => ({
        policy: 'summary',
        currentTokens: 80,
        maxTokens: 100,
        threshold: 0.85,
        sources: { messages: 60, system: 20 },
      })),
      keep: vi.fn(async () => {}),
      unkeep: vi.fn(async () => {}),
      compact: vi.fn(async () => ({ beforeTokens: 80, afterTokens: 50 })),
      getPolicy: vi.fn(async () => ({ name: 'summary', params: { keepRecent: 20 } })),
      setPolicy: vi.fn(async () => {}),
    }
    expect((await runCli(['context', 'show', '--json'], ports({ context }))).stdout).toContain(
      '"policy":"summary"',
    )
    await runCli(['context', 'keep', 'm1'], ports({ context }))
    await runCli(['context', 'compact', 'summary'], ports({ context }))
    await runCli(['context', 'policy', 'set', 'sliding', 'keepRecent=30'], ports({ context }))
    expect(context.keep).toHaveBeenCalledWith('m1')
    expect(context.compact).toHaveBeenCalledWith('summary')
    expect(context.setPolicy).toHaveBeenCalledWith('sliding', { keepRecent: '30' })
  })

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

  it('uses NDJSON only for a JSON chat and disables human/TUI output', async () => {
    const testPorts = ports()
    testPorts.session.configureOutput = vi.fn(({ write }) => {
      write('{"v":1,"type":"final"}\n')
    })
    const result = await runCli(['chat', 'hello', '--json'], testPorts)
    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '{"v":1,"type":"final"}\n' })
    expect(testPorts.session.configureOutput).toHaveBeenCalledWith({
      json: true,
      write: expect.any(Function),
    })
  })

  it('keeps management --json output as one JSON document', async () => {
    const result = await runCli(['doctor', '--json'], ports())
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true)
  })

  it('returns stable error and final events for invalid JSON chat usage', async () => {
    const result = await runCli(['chat', '--json'], ports())
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(result).toMatchObject({ exitCode: 2, stderr: '' })
    expect(events).toMatchObject([
      {
        type: 'error',
        data: { code: 'prompt_required', category: 'usage', retryable: false, exitCode: 2 },
      },
      { type: 'final', data: { status: 'error', exitCode: 2 } },
    ])
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

  it('supports restore dry-runs and reports conflicts without writing', async () => {
    const restore = {
      restore: vi.fn(async () => ({
        restored: ['/work/a.ts'],
        conflicts: [],
        missing: false,
        dryRun: true,
      })),
    }
    const result = await runCli(['restore', 'session-42', '--dry-run'], ports({ restore }))
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).toContain('Would restore 1 file(s)')
    expect(restore.restore).toHaveBeenCalledWith('session-42', { dryRun: true })
  })

  it('connects stdin login without including the credential in output', async () => {
    const testPorts = ports()
    const result = await runCli(['login', 'anthropic', '--api-key-stdin'], testPorts, {
      readStdin: async () => 'super-secret\n',
    })
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(result.stdout).not.toContain('super-secret')
    expect(testPorts.auth.login).toHaveBeenCalledWith({
      provider: 'anthropic',
      credential: 'super-secret',
      flow: 'stdin',
      dangerouslySkipVerify: false,
    })
  })

  it('requires --dangerous when verification is skipped', async () => {
    const testPorts = ports()
    const result = await runCli(['login', 'anthropic', '--skip-verify'], testPorts)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--dangerous')
    expect(testPorts.auth.login).not.toHaveBeenCalled()
  })

  it('connects logout to credential revocation', async () => {
    const testPorts = ports()
    const result = await runCli(['logout', 'anthropic'], testPorts)
    expect(result.exitCode).toBe(0)
    expect(testPorts.auth.logout).toHaveBeenCalledWith('anthropic')
  })
})
