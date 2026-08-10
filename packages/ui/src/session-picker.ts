export interface SessionCandidate {
  id: string
  cwd: string
  updatedAt: string
  title: string
  summary?: string
}

export interface SessionPickerState {
  sessions: readonly SessionCandidate[]
  query: string
  selected: number
}

export type SessionPickerAction =
  | { type: 'cancel' }
  | { type: 'select'; session: SessionCandidate }
  | { type: 'update'; state: SessionPickerState }

export function filterSessions(
  sessions: readonly SessionCandidate[],
  query: string,
): SessionCandidate[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return [...sessions]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
    .filter((session) => {
      const haystack = [session.title, session.summary, session.id, session.cwd]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase()
      return terms.every((term) => fuzzyIncludes(haystack, term))
    })
}

export function createSessionPickerState(
  sessions: readonly SessionCandidate[],
): SessionPickerState {
  return { sessions, query: '', selected: 0 }
}

export function sessionPickerKey(state: SessionPickerState, key: string): SessionPickerAction {
  const filtered = filterSessions(state.sessions, state.query)
  if (key === 'Escape') return { type: 'cancel' }
  if (key === 'Enter') {
    const session = filtered[state.selected]
    return session ? { type: 'select', session } : { type: 'update', state }
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (!filtered.length) return { type: 'update', state: { ...state, selected: 0 } }
    const delta = key === 'ArrowUp' ? -1 : 1
    return {
      type: 'update',
      state: { ...state, selected: (state.selected + delta + filtered.length) % filtered.length },
    }
  }
  if (key === 'Backspace' || key === 'Delete')
    return {
      type: 'update',
      state: { ...state, query: state.query.slice(0, -1), selected: 0 },
    }
  const code = key.codePointAt(0)
  if (code !== undefined && key.length <= 2 && code >= 32 && code !== 127)
    return { type: 'update', state: { ...state, query: state.query + key, selected: 0 } }
  return { type: 'update', state }
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true
  let index = 0
  for (const char of haystack) if (char === needle[index]) index += 1
  return index === needle.length
}
