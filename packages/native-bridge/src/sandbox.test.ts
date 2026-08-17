import { describe, expect, it, vi } from 'vitest'

import { nativeProbes } from './probe'
import { execSandbox, probeSandbox } from './sandbox'
import type { ExecOptions } from './types'

const execOptions: ExecOptions = {
  command: 'echo hi',
  cwd: process.cwd(),
  permissions: { fs: { read: [], write: [] }, net: false, env: { read: [] } },
}

describe('sandbox probe', () => {
  it('is frozen for the lifetime of the process', async () => {
    const first = await probeSandbox()
    const second = await probeSandbox()
    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.features)).toBe(true)
  })

  it('side-effect execution waits for the startup probe with the remaining budget (r13-P1)', async () => {
    vi.useFakeTimers()
    try {
      nativeProbes.registerSources({
        sandbox: () => new Promise(() => {}),
        worker: () => new Promise(() => {}),
      })
      nativeProbes.start()
      const execution = execSandbox(execOptions)
      const assertion = expect(execution).rejects.toThrow(
        'sandbox unavailable; refusing unsandboxed execution',
      )
      // The probe hangs; execution only gives up when the startup budget expires.
      await vi.advanceTimersByTimeAsync(5_001)
      await assertion
      // Once settled unavailable, later side-effect calls fail fast.
      await expect(execSandbox(execOptions)).rejects.toThrow(
        'sandbox unavailable; refusing unsandboxed execution',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
