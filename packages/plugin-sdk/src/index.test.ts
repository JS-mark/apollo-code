import { describe, expect, it } from 'vitest'

import { definePlugin, defineTool } from './index'
describe('plugin sdk', () => {
  it('is runtime-free identity helpers', () => {
    const plugin = { activate() {} }
    const tool = { name: 'x' }
    expect(definePlugin(plugin)).toBe(plugin)
    expect(defineTool(tool)).toBe(tool)
  })
})
