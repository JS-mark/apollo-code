import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '@volund/storage'
import { afterEach, describe, expect, it } from 'vitest'

import { SCHEDULE_TASK_TOOL_NAME, createScheduleTaskTool } from './schedule-task-tool'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(
  overrides: {
    enabled?: boolean
    daemonRunning?: boolean
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'volund-schedule-tool-'))
  directories.push(home)
  await writeFile(join(home, 'config.toml'), `[tasks]\nenabled = ${overrides.enabled ?? true}\n`)
  const tool = createScheduleTaskTool({
    home,
    sessionCwd: '/session/cwd',
    status: async () => ({
      enabled: overrides.enabled ?? true,
      daemonRunning: overrides.daemonRunning ?? true,
    }),
  })
  const context = { session: { id: 'sess-1', cwd: '/session/cwd' } } as never
  const invoke = (input: unknown) => {
    const spec = tool.permissionSpec(input)
    // 只读动作必须放行（空 spec），变更动作必须带 custom 门。
    if (spec.custom === undefined) {
      const action = (input as { action?: string }).action
      if (action && action !== 'list' && action !== 'runs') {
        throw new Error(`mutating action '${action}' must declare a permission spec`)
      }
    }
    return tool.invoke(input, context)
  }
  const parse = async (input: unknown) => {
    const result = await invoke(input)
    const part = result.content[0]!
    if (part.type !== 'text') throw new Error('expected a text content part')
    return JSON.parse(part.text) as Record<string, unknown>
  }
  return { home, tool, invoke, parse }
}

describe('schedule_task tool', () => {
  it('creates a task freezing the current config hash and session cwd', async () => {
    const { home, parse } = await harness()
    const result = await parse({
      action: 'create',
      name: 'Nightly Sync',
      prompt: 'pull and test',
      schedule: { kind: 'daily', at: '03:30' },
    })
    expect(result.created).toMatchObject({
      id: 'nightly-sync',
      schedule: { kind: 'daily', at: '03:30' },
      cwd: '/session/cwd',
      enabled: true,
    })
    expect(result.warnings).toBeUndefined()

    const store = new TaskStore(join(home, 'tasks.json'))
    const [task] = await store.listTasks()
    expect(task?.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(task?.createdAt).toBeGreaterThan(0)
  })

  it('reports trigger-readiness warnings when disabled or daemon is absent', async () => {
    const { parse } = await harness({ enabled: false, daemonRunning: false })
    const result = await parse({
      action: 'create',
      name: 'Job',
      prompt: 'p',
      schedule: { kind: 'interval', everyMs: 300_000 },
    })
    const warnings = result.warnings as string[]
    expect(warnings.some((note) => note.includes('[tasks]'))).toBe(true)
    expect(warnings.some((note) => note.includes('volund daemon'))).toBe(true)
  })

  it('lists, toggles, removes and shows runs', async () => {
    const { parse } = await harness()
    await parse({
      action: 'create',
      name: 'Job',
      prompt: 'p',
      schedule: { kind: 'weekly', weekdays: [1, 3], at: '09:00' },
    })

    const listed = await parse({ action: 'list' })
    expect(JSON.stringify(listed)).toContain('job')

    expect(await parse({ action: 'disable', id: 'job' })).toEqual({
      updated: { id: 'job', enabled: false },
    })
    expect(await parse({ action: 'enable', id: 'job' })).toEqual({
      updated: { id: 'job', enabled: true },
    })

    const runs = await parse({ action: 'runs', id: 'job', limit: 5 })
    expect(runs).toEqual([])

    expect(await parse({ action: 'remove', id: 'job' })).toEqual({ removed: 'job' })
    expect((await parse({ action: 'remove', id: 'job' })).error).toContain('no such task')
  })

  it('surfaces validation issues without throwing', async () => {
    const { parse } = await harness()
    const result = await parse({
      action: 'create',
      name: 'Bad',
      prompt: 'p',
      schedule: { kind: 'daily', at: '99:99' },
    })
    expect(result.error).toBe('validation failed')
    expect(result.issues).toEqual([{ path: 'schedule.at', message: 'expected HH:MM (24h)' }])
  })

  it('requires fields per action and gates mutations with a custom permission spec', async () => {
    const { tool, parse } = await harness()
    expect(tool.name).toBe(SCHEDULE_TASK_TOOL_NAME)
    expect((await parse({ action: 'create', name: 'X' })).error).toContain(
      'name, prompt and schedule',
    )
    expect((await parse({ action: 'runs' })).error).toContain('id is required')

    const spec = tool.permissionSpec({ action: 'create', id: 'abc' })
    expect(spec).toMatchObject({ custom: { scheduleTask: { action: 'create', id: 'abc' } } })
    expect(tool.permissionSpec({ action: 'list' })).toEqual({})
  })
})
