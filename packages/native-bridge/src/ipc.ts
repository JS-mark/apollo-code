import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

interface Deferred {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export class RpcPeer {
  private readonly pending = new Map<number, Deferred>()
  private readonly notifications = new Map<string, Array<(params: unknown) => void>>()
  private nextId = 1

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    createInterface({ input }).on('line', (line) => {
      let frame: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { message?: string }
      }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        return
      }
      if (frame.method) {
        for (const listener of this.notifications.get(frame.method) ?? []) listener(frame.params)
        this.notifications.delete(frame.method)
      }
      if (typeof frame.id !== 'number') return
      const deferred = this.pending.get(frame.id)
      if (!deferred) return
      this.pending.delete(frame.id)
      if (frame.error) deferred.reject(new Error(frame.error.message ?? 'worker RPC failed'))
      else deferred.resolve(frame.result)
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.requestWithId(this.nextId++, method, params)
  }

  notification(method: string): Promise<unknown> {
    return new Promise((resolve) =>
      this.notifications.set(method, [...(this.notifications.get(method) ?? []), resolve]),
    )
  }

  requestWithId(id: number, method: string, params: unknown): Promise<unknown> {
    const result = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    )
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return result
  }

  close(reason = new Error('worker closed')): void {
    for (const deferred of this.pending.values()) deferred.reject(reason)
    this.pending.clear()
  }
}
