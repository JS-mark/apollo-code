import { describe, expect, it } from 'vitest'

import { Telemetry, type TelemetryEvent } from './index'
describe('telemetry', () => {
  it('sanitizes every event before the local sink', async () => {
    let event: TelemetryEvent | undefined
    await new Telemetry({
      write: async (value) => {
        event = value
      },
    }).emit('auth.test', 'auth', { token: 'abc', url: 'https://user:pass@example.com' })
    const payload = JSON.stringify(event?.payload)
    expect(payload).not.toContain('abc')
    expect(payload).not.toContain('user:pass')
  })
})
