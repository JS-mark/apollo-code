import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { WorkerPool } from '../worker-pool'

function fakeWorker() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
    pid: number
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  child.pid = 42
  queueMicrotask(() =>
    child.stdout.write('{"jsonrpc":"2.0","method":"worker.ready","params":{"protocol":1}}\n'),
  )
  return child
}

describe('WorkerPool', () => {
  it('handshakes and correlates JSON-RPC responses', async () => {
    const child = fakeWorker()
    child.stdin.on('data', (raw) => {
      const request = JSON.parse(String(raw)) as { id: number }
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 7 })}\n`)
    })
    const pool = new WorkerPool({ resolve: async () => '/worker', spawn: () => child as never })
    await expect(pool.call('fs', 'fs.count_tokens', {})).resolves.toBe(7)
    await pool.close()
  })

  it('degrades after three crashes in one session', async () => {
    const children = [fakeWorker(), fakeWorker(), fakeWorker()]
    const pool = new WorkerPool({
      resolve: async () => '/worker',
      spawn: () => children.shift() as never,
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = await pool.ensureWorker('search')
      worker?.emit('exit', 9, null)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await pool.ensureWorker('search')).toBeNull()
    expect(pool.status('search').restartCount).toBe(3)
    await pool.close()
  })

  it('re-arms the crash breaker once a worker survives the stability window', async () => {
    vi.useFakeTimers()
    const children = [fakeWorker(), fakeWorker(), fakeWorker(), fakeWorker()]
    const pool = new WorkerPool({
      crashResetMs: 100,
      resolve: async () => '/worker',
      spawn: () => children.shift() as never,
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const worker = await pool.ensureWorker('search')
      worker?.emit('exit', 9, null)
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(await pool.ensureWorker('search')).toBeNull()
    // The breaker only clears while a worker is alive through the window;
    // after three fast crashes there is no live handle, so it stays tripped.
    await vi.advanceTimersByTimeAsync(101)
    expect(await pool.ensureWorker('search')).toBeNull()
    vi.useRealTimers()
    await pool.close()
  })

  it('a surviving worker clears the breaker and allows a later respawn', async () => {
    vi.useFakeTimers()
    const children = [fakeWorker(), fakeWorker()]
    const pool = new WorkerPool({
      crashResetMs: 100,
      resolve: async () => '/worker',
      spawn: () => children.shift() as never,
    })
    await pool.ensureWorker('search')
    await vi.advanceTimersByTimeAsync(101)
    expect(pool.status('search').restartCount).toBe(0)
    const current = await pool.ensureWorker('search')
    current?.emit('exit', 9, null)
    await vi.advanceTimersByTimeAsync(0)
    // One crash since the reset: the breaker (limit 3) allows a respawn.
    expect(await pool.ensureWorker('search')).not.toBeNull()
    vi.useRealTimers()
    await pool.close()
  })

  it('concurrent ensureWorker calls share a single spawn', async () => {
    let spawns = 0
    const pool = new WorkerPool({
      resolve: async () => '/worker',
      spawn: () => {
        spawns += 1
        return fakeWorker() as never
      },
    })
    const [first, second] = await Promise.all([pool.ensureWorker('fs'), pool.ensureWorker('fs')])
    expect(spawns).toBe(1)
    expect(first).toBe(second)
    await pool.close()
  })

  it('reaps an idle worker', async () => {
    vi.useFakeTimers()
    const child = fakeWorker()
    const pool = new WorkerPool({
      idleMs: 30,
      resolve: async () => '/worker',
      spawn: () => child as never,
    })
    await pool.ensureWorker('fs')
    await vi.advanceTimersByTimeAsync(31)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    vi.useRealTimers()
  })
})
