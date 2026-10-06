import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'

import { VolundError } from '@volund/shared'

import { RpcPeer, type IpcTelemetry } from './ipc'
import { resolveBinary } from './resolver'

export type WorkerKind = 'search' | 'fs'
type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams
interface Options {
  idleMs?: number
  handshakeMs?: number
  /** A worker alive this long clears the consecutive-crash breaker (default 10s). */
  crashResetMs?: number
  ipcMaxLineBytes?: number
  telemetry?: IpcTelemetry
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
  /** In-flight spawns per kind: ensureWorker is single-flight, never double-spawns. */
  private readonly ensuring = new Map<WorkerKind, Promise<ChildProcessWithoutNullStreams | null>>()
  private readonly idleMs: number
  private readonly handshakeMs: number
  private readonly crashResetMs: number
  private readonly ipcMaxLineBytes: number | undefined
  private readonly telemetry: IpcTelemetry | undefined
  private readonly resolve: typeof resolveBinary
  private readonly spawn: SpawnLike

  constructor(options: Options = {}) {
    this.idleMs = options.idleMs ?? 30_000
    this.handshakeMs = options.handshakeMs ?? 5_000
    this.crashResetMs = options.crashResetMs ?? 10_000
    this.ipcMaxLineBytes = options.ipcMaxLineBytes
    this.telemetry = options.telemetry
    this.resolve = options.resolve ?? resolveBinary
    this.spawn = options.spawn ?? nodeSpawn
  }

  async ensureWorker(kind: WorkerKind): Promise<ChildProcessWithoutNullStreams | null> {
    const existing = this.workers.get(kind)
    if (existing) {
      this.touch(kind, existing)
      return existing.child
    }
    // Single-flight: a probe and a first call racing on a cold kind share one
    // spawn instead of orphaning the loser's worker process.
    const pending = this.ensuring.get(kind)
    if (pending) return pending
    const flight = this.spawnWorker(kind).finally(() => {
      this.ensuring.delete(kind)
    })
    this.ensuring.set(kind, flight)
    return flight
  }

  private async spawnWorker(kind: WorkerKind): Promise<ChildProcessWithoutNullStreams | null> {
    if ((this.restarts.get(kind) ?? 0) >= 3) return null
    const binary = await this.resolve(kind)
    if (!binary) return null
    const child = this.spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const rpc = new RpcPeer(child.stdout, child.stdin, {
      maxLineBytes: this.ipcMaxLineBytes,
      telemetry: this.telemetry,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = (await Promise.race([
      rpc.notification('worker.ready'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(
            new VolundError(
              'native_bridge_worker_handshake_timeout',
              `${kind} worker handshake timed out`,
            ),
          )
        }, this.handshakeMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })) as { protocol?: number }
    if (ready.protocol !== 1) {
      child.kill('SIGKILL')
      throw new VolundError('native_bridge_worker_handshake_invalid', 'invalid worker handshake')
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
    // The three-crash breaker counts consecutive failures: a worker that stays
    // up through the stability window re-arms the breaker so a flaky morning
    // never permanently disables the native path for the whole session.
    const stability = setTimeout(() => {
      if (this.workers.get(kind) === handle) this.restarts.delete(kind)
    }, this.crashResetMs)
    stability.unref?.()
    return child
  }

  async call(kind: WorkerKind, method: string, params: unknown): Promise<unknown> {
    const child = await this.ensureWorker(kind)
    if (!child)
      throw new VolundError('native_bridge_worker_unavailable', `${kind} worker unavailable`)
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
