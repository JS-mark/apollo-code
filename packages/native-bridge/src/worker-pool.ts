import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'

import { RpcPeer } from './ipc.ts'
import { resolveBinary } from './resolver.ts'

export type WorkerKind = 'search' | 'fs'
type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams
interface Options {
  idleMs?: number
  handshakeMs?: number
  resolve?: typeof resolveBinary
  spawn?: SpawnLike
}
interface Handle {
  child: ChildProcessWithoutNullStreams
  rpc: RpcPeer
  idle?: ReturnType<typeof setTimeout>
}

export class WorkerPool {
  private readonly workers = new Map<WorkerKind, Handle>()
  private readonly restarts = new Map<WorkerKind, number>()
  private readonly idleMs: number
  private readonly handshakeMs: number
  private readonly resolve: typeof resolveBinary
  private readonly spawn: SpawnLike

  constructor(options: Options = {}) {
    this.idleMs = options.idleMs ?? 30_000
    this.handshakeMs = options.handshakeMs ?? 5_000
    this.resolve = options.resolve ?? resolveBinary
    this.spawn = options.spawn ?? nodeSpawn
  }

  async ensureWorker(kind: WorkerKind): Promise<ChildProcessWithoutNullStreams | null> {
    const existing = this.workers.get(kind)
    if (existing) {
      this.touch(kind, existing)
      return existing.child
    }
    if ((this.restarts.get(kind) ?? 0) >= 3) return null
    const binary = await this.resolve(kind)
    if (!binary) return null
    const child = this.spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const rpc = new RpcPeer(child.stdout, child.stdin)
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = (await Promise.race([
      rpc.notification('worker.ready'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`${kind} worker handshake timed out`))
        }, this.handshakeMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })) as { protocol?: number }
    if (ready.protocol !== 1) {
      child.kill('SIGKILL')
      throw new Error('invalid worker handshake')
    }
    const handle: Handle = { child, rpc }
    child.once('exit', () => {
      if (this.workers.get(kind)?.child !== child) return
      handle.rpc.close()
      if (handle.idle) clearTimeout(handle.idle)
      this.workers.delete(kind)
      this.restarts.set(kind, (this.restarts.get(kind) ?? 0) + 1)
    })
    this.workers.set(kind, handle)
    this.touch(kind, handle)
    return child
  }

  async call(kind: WorkerKind, method: string, params: unknown): Promise<unknown> {
    const child = await this.ensureWorker(kind)
    if (!child) throw new Error(`${kind} worker unavailable`)
    const handle = this.workers.get(kind)!
    this.touch(kind, handle)
    return handle.rpc.request(method, params)
  }

  status(kind: WorkerKind): { available: boolean; pid?: number; restartCount: number } {
    const handle = this.workers.get(kind)
    const status = { available: Boolean(handle), restartCount: this.restarts.get(kind) ?? 0 }
    return handle?.child.pid === undefined ? status : { ...status, pid: handle.child.pid }
  }

  async close(): Promise<void> {
    for (const handle of this.workers.values()) {
      handle.rpc.close()
      handle.child.kill('SIGTERM')
    }
    this.workers.clear()
  }

  private touch(kind: WorkerKind, handle: Handle): void {
    if (handle.idle) clearTimeout(handle.idle)
    handle.idle = setTimeout(() => {
      if (this.workers.get(kind) === handle) {
        this.workers.delete(kind)
        handle.rpc.close()
        handle.child.kill('SIGTERM')
      }
    }, this.idleMs)
    handle.idle.unref?.()
  }
}

export const workerPool = new WorkerPool()
