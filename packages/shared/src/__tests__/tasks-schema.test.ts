import { describe, expect, it } from 'vitest'

import { parseHhmm, validateTaskDefinition } from '../tasks-schema'

const validDefinition = {
  id: 'nightly-sync',
  name: 'Nightly sync',
  enabled: true,
  prompt: 'pull main and run tests',
  cwd: '/home/me/repo',
  schedule: { kind: 'daily', at: '03:30' },
  missedRun: 'skip',
  overlap: 'skip',
  createdAt: 1_700_000_000_000,
}

describe('validateTaskDefinition', () => {
  it('accepts a minimal definition and keeps unknown fields out', () => {
    const result = validateTaskDefinition(validDefinition)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.schedule).toEqual({ kind: 'daily', at: '03:30' })
    expect(result.value).not.toHaveProperty('dangerouslySkipPermissions')
  })

  it('accepts the full frozen-contract shape (F1-02)', () => {
    const result = validateTaskDefinition({
      ...validDefinition,
      timezone: 'Asia/Shanghai',
      configHash: 'a'.repeat(64),
      constraints: {
        model: 'anthropic/claude-sonnet-4',
        budget: { costUSDMax: 1.5, tokenMax: 100_000, timeMsMax: 600_000 },
        allowedTools: ['Read', 'Bash'],
        timeoutMs: 300_000,
        maxRetries: 2,
      },
    })
    expect(result.ok).toBe(true)
  })

  it('reports the offending path for a bad id and schedule', () => {
    const result = validateTaskDefinition({
      ...validDefinition,
      id: 'Bad Id',
      schedule: { kind: 'daily', at: '24:00' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const paths = result.issues.map((issue) => issue.path)
    expect(paths).toContain('id')
    expect(paths).toContain('schedule.at')
  })

  it('rejects unknown keys (no place to store a permission bypass, W-17 F1-02)', () => {
    const result = validateTaskDefinition({
      ...validDefinition,
      permissions: { mode: 'full' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('"permissions"'))).toBe(true)
  })

  it('rejects relative cwd, sub-minute intervals and bad time zones', () => {
    expect(validateTaskDefinition({ ...validDefinition, cwd: 'repo' }).ok).toBe(false)
    expect(
      validateTaskDefinition({
        ...validDefinition,
        schedule: { kind: 'interval', everyMs: 30_000 },
      }).ok,
    ).toBe(false)
    expect(validateTaskDefinition({ ...validDefinition, timezone: 'Mars/Olympus' }).ok).toBe(false)
    expect(validateTaskDefinition({ ...validDefinition, timezone: 'UTC' }).ok).toBe(true)
  })

  it('bounds maxRetries and requires positive budget numbers', () => {
    expect(
      validateTaskDefinition({
        ...validDefinition,
        constraints: { maxRetries: 11 },
      }).ok,
    ).toBe(false)
    expect(
      validateTaskDefinition({
        ...validDefinition,
        constraints: { budget: { costUSDMax: -1 } },
      }).ok,
    ).toBe(false)
  })
})

describe('parseHhmm', () => {
  it('parses 24h wall clock', () => {
    expect(parseHhmm('00:00')).toEqual({ hour: 0, minute: 0 })
    expect(parseHhmm('23:59')).toEqual({ hour: 23, minute: 59 })
  })

  it('rejects out-of-range times', () => {
    expect(() => parseHhmm('24:00')).toThrow(RangeError)
    expect(() => parseHhmm('7:30')).toThrow(RangeError)
  })
})
