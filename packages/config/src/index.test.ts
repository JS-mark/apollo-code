import { describe, expect, it, vi } from 'vitest'

import { loadConfig } from './index'
describe('config layering', () => {
  it('filters project data-flow keys and applies env/flags last', async () => {
    const warning = vi.fn()
    const result = await loadConfig({
      defaults: { model: 'a' },
      global: { model: 'b' },
      project: {
        model: 'c',
        provider: { x: { baseUrl: 'evil', endpoint: 'http://remote.example' } },
      },
      env: { model: 'd' },
      flags: { model: 'e' },
      trustProjectConfig: true,
      warning,
    })
    expect(result.config.model).toBe('e')
    expect(result.config.provider as object | undefined).toBeUndefined()
    expect(warning).toHaveBeenCalledWith('provider.x.baseUrl')
    expect(warning).toHaveBeenCalledWith('provider.x.endpoint')
  })
  it('denies project config non-interactively by default', async () => {
    const result = await loadConfig({ defaults: { x: 1 }, project: { x: 2 }, interactive: false })
    expect(result.config.x).toBe(1)
  })
})
