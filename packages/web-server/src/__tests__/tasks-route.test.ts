import { afterEach, describe, expect, it } from 'vitest'

import { createWebServer } from '../index'
import type { TasksPortLike, WebServerHandle } from '../index'

let handle: WebServerHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

async function start(tasks?: TasksPortLike): Promise<WebServerHandle> {
  handle = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    ports: { identity: { version: '0.0.0-test' }, cwd: '/tmp/web-server-test' },
    ...(tasks ? { tasks } : {}),
  })
  return handle
}

async function authedGet(url: string, path: string): Promise<{ status: number; data: unknown }> {
  const base = new URL(url).origin + '/'
  const bootstrap = await fetch(`${base}api/v1/bootstrap`)
  const cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0]!
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, { headers: { Cookie: cookie } })
  // 响应统一包 { data }（ok() 助手）。
  const wrapped = (await res.json()) as { data?: unknown }
  return { status: res.status, data: wrapped.data }
}

const tasksPort: TasksPortLike = {
  status: async () => ({
    enabled: true,
    daemonRunning: true,
    pid: 4242,
    taskCount: 1,
  }),
  list: async () => [
    {
      id: 'nightly-sync',
      name: 'Nightly sync',
      enabled: true,
      prompt: 'pull and test',
      cwd: '/repo',
      schedule: { kind: 'daily', at: '03:30' },
      missedRun: 'skip',
      overlap: 'skip',
      createdAt: 1_700_000_000_000,
    },
  ],
  setEnabled: async (id, enabled) => ({ id, enabled }),
  remove: async (id) => ({ removed: true, id }),
  runs: async (taskId, limit) => {
    const all = [
      {
        runId: 'r1',
        taskId: 'nightly-sync',
        status: 'completed' as const,
        scheduledFor: 1_700_000_100_000,
        exitCode: 0,
        sessionId: 'sess_child',
      },
      {
        runId: 'r2',
        taskId: 'other',
        status: 'failed' as const,
        scheduledFor: 1_700_000_200_000,
        error: { code: 'task_run_failed', message: 'run exited with code 1' },
      },
    ]
    return all.filter((run) => !taskId || run.taskId === taskId).slice(0, limit)
  },
}

describe('GET /api/v1/tasks (W-17 read-only surface)', () => {
  it('serves scheduler status and task definitions', async () => {
    const server = await start(tasksPort)
    const { status, data } = await authedGet(server.url, '/api/v1/tasks')
    expect(status).toBe(200)
    expect(data).toMatchObject({
      status: { enabled: true, daemonRunning: true, pid: 4242, taskCount: 1 },
      tasks: [{ id: 'nightly-sync', schedule: { kind: 'daily', at: '03:30' } }],
    })
  })

  it('serves the run journal with task filter and limit clamp', async () => {
    const server = await start(tasksPort)
    const filtered = await authedGet(server.url, '/api/v1/tasks/runs?task=nightly-sync&limit=99')
    expect(filtered.status).toBe(200)
    expect(filtered.data).toMatchObject({
      runs: [{ runId: 'r1', status: 'completed', sessionId: 'sess_child' }],
    })
    const unfiltered = await authedGet(server.url, '/api/v1/tasks/runs?limit=0')
    expect((unfiltered.data as { runs: unknown[] }).runs).toHaveLength(2)
  })

  it('mutates definitions via POST (enable toggle + remove)', async () => {
    const server = await start(tasksPort)
    const base = new URL(server.url).origin
    const bootstrap = await fetch(`${base}/api/v1/bootstrap`)
    const cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0]!
    const body = (await bootstrap.json()) as { data: { session: { csrfToken: string } } }
    const post = async (path: string, payload: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: base,
          'X-Volund-Csrf': body.data.session.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

    const toggled = await post('/api/v1/tasks/set-enabled', { id: 'nightly-sync', enabled: false })
    expect(toggled.status).toBe(200)
    expect(await toggled.json()).toMatchObject({ data: { id: 'nightly-sync', enabled: false } })

    const removed = await post('/api/v1/tasks/remove', { id: 'nightly-sync' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ data: { removed: true } })

    const bad = await post('/api/v1/tasks/set-enabled', { id: '' })
    expect(bad.status).toBe(400)
  })

  it('reports web_capability_unavailable without the port (mutation-free by design)', async () => {
    const server = await start(undefined)
    const base = new URL(server.url).origin
    const bootstrap = await fetch(`${base}/api/v1/bootstrap`)
    const cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0]!
    const res = await fetch(`${base}/api/v1/tasks`, { headers: { Cookie: cookie } })
    // 错误响应恒为顶层 { error }（不走 { data } 包装）。
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'web_capability_unavailable' } })
  })
})
