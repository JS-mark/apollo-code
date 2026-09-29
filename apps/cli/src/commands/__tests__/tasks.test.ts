import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { computeConfigHash, taskStorePath } from '../../daemon'
import type { VolundPorts } from '../../ports'
import { tasksCommand, parseScheduleSpec, volundHome } from '../tasks'

const directories: string[] = []

afterEach(async () => {
  delete process.env.VOLUND_HOME
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function withTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-tasks-cmd-'))
  directories.push(dir)
  process.env.VOLUND_HOME = dir
  return dir
}

const portsStub = {} as VolundPorts

/** 手工模拟 citty 的解析：--flag value / --flag 进 flags，其余进位置参数。 */
function run(argv: string[], cwd = '/tmp/repo') {
  const positional: string[] = []
  const flags: Record<string, unknown> = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith('--')) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[token.slice(2)] = next
        index++
      } else {
        flags[token.slice(2)] = true
      }
    } else {
      positional.push(token)
    }
  }
  return tasksCommand.run({
    args: { _: ['tasks', ...positional], ...flags } as Parameters<
      typeof tasksCommand.run
    >[0]['args'],
    cwd,
    ports: portsStub,
  })
}

describe('parseScheduleSpec', () => {
  it('parses the three spec forms', () => {
    expect(parseScheduleSpec('interval:5m')).toEqual({ kind: 'interval', everyMs: 300_000 })
    expect(parseScheduleSpec('interval:90s')).toEqual({ kind: 'interval', everyMs: 90_000 })
    expect(parseScheduleSpec('daily:03:30')).toEqual({ kind: 'daily', at: '03:30' })
    expect(parseScheduleSpec('weekly:mon,wed,fri@09:00')).toEqual({
      kind: 'weekly',
      weekdays: [1, 3, 5],
      at: '09:00',
    })
    expect(parseScheduleSpec('weekly:0,6@23:59')).toEqual({
      kind: 'weekly',
      weekdays: [0, 6],
      at: '23:59',
    })
  })

  it('rejects malformed specs', () => {
    expect(() => parseScheduleSpec('cron:*/5')).toThrow(RangeError)
    expect(() => parseScheduleSpec('weekly:mon,tue@9:00')).toThrow(RangeError)
    expect(() => parseScheduleSpec('interval:5')).toThrow(RangeError)
  })
})

describe('tasks command', () => {
  it('adds a task freezing the current config hash and defaults', async () => {
    const home = await withTempHome()
    const result = await run([
      'add',
      '--name',
      'Nightly Sync',
      '--prompt',
      'pull and test',
      '--schedule',
      'daily:03:30',
    ])
    expect(result.exitCode).toBe(0)
    const store = new (await import('@volund/storage')).TaskStore(taskStorePath(home))
    const [task] = await store.listTasks()
    expect(task).toMatchObject({
      id: 'nightly-sync',
      enabled: true,
      cwd: '/tmp/repo',
      schedule: { kind: 'daily', at: '03:30' },
      missedRun: 'skip',
      overlap: 'skip',
    })
    expect(task?.configHash).toBe(await computeConfigHash(home))
  })

  it('rejects a bad schedule spec and missing flags', async () => {
    await withTempHome()
    expect(
      (await run(['add', '--name', 'X', '--prompt', 'p', '--schedule', 'cron:*/5'])).exitCode,
    ).toBe(2)
    expect((await run(['add', '--name', 'X'])).exitCode).toBe(2)
    expect(
      (
        await run([
          'add',
          '--name',
          'X',
          '--prompt',
          'p',
          '--schedule',
          'daily:03:30',
          '--tz',
          'Mars/Olympus',
        ])
      ).exitCode,
    ).toBe(2)
  })

  it('lists, toggles, removes and shows runs', async () => {
    const home = await withTempHome()
    await run(['add', '--name', 'Job', '--prompt', 'p', '--schedule', 'interval:5m'])

    const listed = await run(['list'])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain('job')

    expect((await run(['disable', 'job'])).stdout).toContain('disabled')
    const store = new (await import('@volund/storage')).TaskStore(taskStorePath(home))
    expect((await store.getTask('job'))?.enabled).toBe(false)
    expect((await run(['enable', 'job'])).stdout).toContain('enabled')

    expect((await run(['runs', 'job'])).stdout).toContain('No runs recorded')
    await store.recordRun({
      runId: 'r1',
      taskId: 'job',
      status: 'completed',
      scheduledFor: 1_770_000_000_000,
      exitCode: 0,
      sessionId: 'sess_1',
    })
    const runs = await run(['runs', 'job'])
    expect(runs.stdout).toContain('completed')
    expect(runs.stdout).toContain('sess_1')

    expect((await run(['remove', 'job'])).exitCode).toBe(0)
    expect((await run(['remove', 'job'])).exitCode).toBe(1)
    expect((await run(['enable', 'nope'])).exitCode).toBe(1)
  })

  it('honors VOLUND_HOME for the store path', async () => {
    const home = await withTempHome()
    expect(volundHome()).toBe(home)
    expect(taskStorePath(home)).toBe(join(home, 'tasks.json'))
  })
})
