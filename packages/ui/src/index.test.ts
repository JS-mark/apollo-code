import { describe, expect, it } from 'vitest'

import {
  renderDirectoryTrustPrompt,
  renderInteractiveApp,
  statusPanelFromWelcome,
  validateStatusConfigValue,
} from './index'

describe('package root exports', () => {
  it('exposes CLI-facing status and TUI helpers', () => {
    expect(statusPanelFromWelcome).toBeTypeOf('function')
    expect(validateStatusConfigValue).toBeTypeOf('function')
    expect(renderDirectoryTrustPrompt).toBeTypeOf('function')
    expect(renderInteractiveApp).toBeTypeOf('function')
  })
})
