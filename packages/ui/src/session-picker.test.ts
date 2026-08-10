import { describe, expect, it } from 'vitest'

import { createSessionPickerState, filterSessions, sessionPickerKey } from './session-picker'

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
  it('sorts recent sessions and searches title, id, and path case-insensitively', () => {
    expect(filterSessions(sessions, '').map((item) => item.id)).toEqual([
      'aaa-session',
      'bbb-session',
    ])
    expect(filterSessions(sessions, 'LOGIN').map((item) => item.id)).toEqual(['bbb-session'])
    expect(filterSessions(sessions, 'aas').map((item) => item.id)).toEqual(['aaa-session'])
    expect(filterSessions(sessions, 'beta').map((item) => item.id)).toEqual(['bbb-session'])
  })

  it('wraps selection, selects, cancels, and clamps after query changes', () => {
    let state = createSessionPickerState(sessions)
    const up = sessionPickerKey(state, 'ArrowUp')
    expect(up.type).toBe('update')
    if (up.type !== 'update') return
    state = up.state
    expect(state.selected).toBe(1)
    expect(sessionPickerKey(state, 'Enter')).toMatchObject({
      type: 'select',
      session: { id: 'bbb-session' },
    })
    const typed = sessionPickerKey(state, 'm')
    expect(typed).toMatchObject({ type: 'update', state: { query: 'm', selected: 0 } })
    expect(sessionPickerKey(state, 'Escape')).toEqual({ type: 'cancel' })
  })

  it('does not select when no results match', () => {
    const state = { ...createSessionPickerState(sessions), query: 'not-found' }
    expect(sessionPickerKey(state, 'Enter').type).toBe('update')
  })
})
