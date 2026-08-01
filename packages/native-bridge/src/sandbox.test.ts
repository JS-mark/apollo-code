import { describe, expect, it } from 'vitest'

import { probeSandbox } from './sandbox.ts'

describe('sandbox probe', () => {
  it('is frozen for the lifetime of the process', async () => {
    const first = await probeSandbox()
    const second = await probeSandbox()
    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.features)).toBe(true)
  })
})
