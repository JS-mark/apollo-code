import { describe, expect, it } from 'vitest'

import {
  createSessionPickerState,
  filterSessions,
  formatSessionTime,
  sessionPickerKey,
  sessionPickerPage,
} from './session-picker'

const sessions = [
  { id: 'bbb-session', cwd: '/work/beta', updatedAt: '2026-08-09T00:00:00Z', title: 'Fix Login' },
  {
    id: 'aaa-session',
    cwd: '/work/alpha',
    updatedAt: '2026-08-10T00:00:00Z',
    title: 'Memory design',
  },
]

describe('session picker', () => {
  it('ranks fuzzy matches across title, summary, id, and path case-insensitively', () => {
    expect(filterSessions(sessions, '').map((item) => item.id)).toEqual([
      'aaa-session',
      'bbb-session',
    ])
    expect(filterSessions(sessions, 'LOGIN').map((item) => item.id)).toEqual(['bbb-session'])
    expect(filterSessions(sessions, 'aas').map((item) => item.id)).toEqual(['aaa-session'])
    expect(filterSessions(sessions, 'beta').map((item) => item.id)).toEqual(['bbb-session'])
    expect(filterSessions(sessions, 'mem des').map((item) => item.id)).toEqual(['aaa-session'])
  })

  it('clamps arrows, pages, jumps to boundaries, selects, and resets after query changes', () => {
    let state = createSessionPickerState(sessions)
    const up = sessionPickerKey(state, 'ArrowUp')
    expect(up.type).toBe('update')
    if (up.type !== 'update') return
    state = up.state
    expect(state.selected).toBe(0)
    const end = sessionPickerKey(state, 'End')
    expect(end).toMatchObject({ type: 'update', state: { selected: 1 } })
    if (end.type !== 'update') return
    state = end.state
    expect(sessionPickerKey(state, 'Enter')).toMatchObject({
      type: 'select',
      session: { id: 'bbb-session' },
    })
    const typed = sessionPickerKey(state, 'm')
    expect(typed).toMatchObject({ type: 'update', state: { query: 'm', selected: 0 } })
    expect(sessionPickerKey(state, 'Escape')).toEqual({ type: 'cancel' })
  })

  it('keeps the selected row visible and supports partial final pages', () => {
    const many = Array.from({ length: 23 }, (_, index) => ({
      id: `session-${index}`,
      cwd: `/work/${index}`,
      updatedAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
      title: `Session ${index}`,
    }))
    let state = createSessionPickerState(many)
    state = { ...state, selected: 9 }
    const crossed = sessionPickerKey(state, 'ArrowDown', 10)
    expect(crossed).toMatchObject({ type: 'update', state: { selected: 10 } })
    if (crossed.type !== 'update') return
    expect(sessionPickerPage(filterSessions(many, ''), crossed.state.selected, 10)).toMatchObject({
      start: 10,
      end: 20,
    })
    state = { ...state, selected: 0 }
    const next = sessionPickerKey(state, 'PageDown', 10)
    expect(next).toMatchObject({ type: 'update', state: { selected: 10 } })
    if (next.type !== 'update') return
    state = next.state
    expect(sessionPickerPage(filterSessions(many, ''), state.selected, 10)).toMatchObject({
      start: 10,
      end: 20,
      total: 23,
    })
    const last = sessionPickerKey(state, 'End', 10)
    if (last.type !== 'update') return
    expect(sessionPickerPage(filterSessions(many, ''), last.state.selected, 10)).toMatchObject({
      start: 20,
      end: 23,
    })
  })

  it('renders semantic time for recent, old, invalid, and future timestamps', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    expect(formatSessionTime('2026-08-10T11:59:45Z', now)).toBe('just now')
    expect(formatSessionTime('2026-08-10T11:55:00Z', now)).toBe('5m ago')
    expect(formatSessionTime('2026-08-10T09:00:00Z', now)).toBe('3h ago')
    expect(formatSessionTime('2026-08-09T10:00:00Z', now)).toBe('yesterday')
    expect(formatSessionTime('2026-08-05T12:00:00Z', now)).toBe('5d ago')
    expect(formatSessionTime('invalid', now)).toBe('time unknown')
    expect(formatSessionTime('2026-08-11T12:00:00Z', now)).not.toContain('ago')
  })

  it('does not select when no results match', () => {
    const state = { ...createSessionPickerState(sessions), query: 'not-found' }
    expect(sessionPickerKey(state, 'Enter').type).toBe('update')
  })
})
