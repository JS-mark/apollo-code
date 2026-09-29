import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
