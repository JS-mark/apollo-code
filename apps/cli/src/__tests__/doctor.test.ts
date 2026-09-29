import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JsonValue } from '@volund/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { runDoctor } from '../doctor'
import type { VolundPorts } from '../ports'

const directories: string[] = []

afterEach(async () => {
  delete process.env.VOLUND_HOME
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-doctor-'))
  directories.push(dir)
  return dir
}

/** runDoctor 必需端口的最小 stub（scheduler 检查走 config.listMerged + daemon.lock）。 */
function portsStub(cwd: string): VolundPorts {
  return {
    identity: { version: '0.0.0-test', commandName: 'volund' },
    native: { health: async () => ({ sandbox: true, search: true, fs: true }) },
    auth: { health: async () => ({ valid: true, detail: 'stub' }) },
    config: {
      health: async () => ({ valid: true, detail: 'stub' }),
      listMerged: async () => ({
        config: {
          tasks: {
            enabled: process.env['VOLUND_TEST_TASKS_ENABLED'] === '1',
          },
        },
        warnings: [],
      }),
    },
    telemetry: { health: async () => ({ writable: true, corruptLines: 0, detail: 'stub' }) },
    trust: {
      check: async () => ({ canonicalPath: cwd, trusted: true }),
      grant: async () => ({ path: cwd, scope: 'exact' }),
      list: async () => [],
      revoke: async () => 0,
      revokeAll: async () => 0,
    },
  } as unknown as VolundPorts
}

function schedulerCheck(checks: Awaited<ReturnType<typeof runDoctor>>) {
  const check = checks.find((entry) => entry.name === 'task scheduler')
  expect(check, 'doctor must report a task scheduler check').toBeDefined()
  return check!
}

describe('doctor task scheduler check', () => {
  it('reports disabled state as healthy when [tasks].enabled is unset', async () => {
    const home = await tempHome()
    process.env.VOLUND_HOME = home
    const checks = await runDoctor('/tmp', portsStub('/tmp'), process.env)
    const check = schedulerCheck(checks)
    expect(check.ok).toBe(true)
    expect(check.warn).toBeUndefined()
    expect(check.detail).toContain('disabled')
  })

  it('warns when scheduling is enabled but no daemon holds the lock', async () => {
    const home = await tempHome()
    process.env.VOLUND_HOME = home
    process.env['VOLUND_TEST_TASKS_ENABLED'] = '1'
    const check = schedulerCheck(await runDoctor('/tmp', portsStub('/tmp'), process.env))
    expect(check.ok).toBe(true)
    expect(check.warn).toBe(true)
    expect(check.detail).toContain('no daemon is running')
  })

  it('reports the live daemon pid when the lock is held', async () => {
    const home = await tempHome()
    process.env.VOLUND_HOME = home
    process.env['VOLUND_TEST_TASKS_ENABLED'] = '1'
    await writeFile(
      join(home, 'daemon.lock'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    )
    const check = schedulerCheck(await runDoctor('/tmp', portsStub('/tmp'), process.env))
    expect(check.ok).toBe(true)
    expect(check.warn).toBeUndefined()
    expect(check.detail).toContain(`pid ${process.pid}`)
  })
})

/** 在 portsStub 上覆写 listMerged，注入 [remote] 段（scheduler 用例不读该键）。 */
function remotePortsStub(cwd: string, remote: Record<string, JsonValue>): VolundPorts {
  const stub = portsStub(cwd) as VolundPorts & {
    config: {
      listMerged: (input: { cwd: string }) => Promise<{
        config: Record<string, JsonValue>
        warnings: string[]
      }>
    }
  }
  stub.config.listMerged = async () => ({ config: { remote }, warnings: [] })
  return stub
}

function remoteCheck(checks: Awaited<ReturnType<typeof runDoctor>>) {
  const check = checks.find((entry) => entry.name === 'remote link')
  expect(check, 'doctor must report a remote link check').toBeDefined()
  return check!
}

describe('doctor remote link check', () => {
  it('reports disabled state as healthy when [remote].enabled is unset', async () => {
    const check = remoteCheck(await runDoctor('/tmp', remotePortsStub('/tmp', {}), process.env))
    expect(check.ok).toBe(true)
    expect(check.warn).toBeUndefined()
    expect(check.detail).toContain('disabled')
  })

  it('warns when enabled but the credential triple is incomplete', async () => {
    const check = remoteCheck(
      await runDoctor(
        '/tmp',
        remotePortsStub('/tmp', { enabled: true, gateway_url: 'https://gw.example' }),
        process.env,
      ),
    )
    expect(check.ok).toBe(true)
    expect(check.warn).toBe(true)
    expect(check.detail).toContain('incomplete')
  })

  it('reports a reachable gateway without warning', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200
      response.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const check = remoteCheck(
        await runDoctor(
          '/tmp',
          remotePortsStub('/tmp', {
            enabled: true,
            gateway_url: `http://127.0.0.1:${port}`,
            client_id: 'client',
            client_secret: 's'.repeat(16),
          }),
          process.env,
        ),
      )
      expect(check.ok).toBe(true)
      expect(check.warn).toBeUndefined()
      expect(check.detail).toContain('gateway reachable')
    } finally {
      server.close()
    }
  })

  it('warns without failing doctor when the gateway is unreachable', async () => {
    const check = remoteCheck(
      await runDoctor(
        '/tmp',
        remotePortsStub('/tmp', {
          enabled: true,
          gateway_url: 'http://127.0.0.1:1',
          client_id: 'client',
          client_secret: 's'.repeat(16),
        }),
        process.env,
      ),
    )
    expect(check.ok).toBe(true)
    expect(check.warn).toBe(true)
    expect(check.detail).toContain('gateway unreachable')
  })
})
