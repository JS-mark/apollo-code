import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import {
  createSessionPickerState,
  filterSessions,
  sessionPickerKey,
  type SessionCandidate,
} from '../session-picker'

export function SessionPicker(props: {
  sessions: readonly SessionCandidate[]
  error?: string
  onCancel(): void
  onSelect(session: SessionCandidate): void
}) {
  const [state, setState] = useState(() => createSessionPickerState(props.sessions))
  const filtered = filterSessions(state.sessions, state.query)
  useInput((input, key) => {
    const name = key.escape
      ? 'Escape'
      : key.return
        ? 'Enter'
        : key.upArrow
          ? 'ArrowUp'
          : key.downArrow
            ? 'ArrowDown'
            : key.backspace || key.delete
              ? 'Backspace'
              : input
    const action = sessionPickerKey(state, name)
    if (action.type === 'cancel') props.onCancel()
    else if (action.type === 'select') props.onSelect(action.session)
    else setState(action.state)
  })
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>Resume session</Text>
      <Text dimColor>
        Search: {state.query || 'type to filter'} · ↑/↓ select · Enter resume · Esc cancel
      </Text>
      {props.error ? <Text color="red">{props.error}</Text> : null}
      {!state.sessions.length ? <Text>No saved sessions.</Text> : null}
      {state.sessions.length && !filtered.length ? (
        <Text>No sessions match “{state.query}”.</Text>
      ) : null}
      {filtered.slice(0, 12).map((session, index) => (
        <Text key={session.id} {...(index === state.selected ? { color: 'cyan' as const } : {})}>
          {index === state.selected ? '› ' : '  '}
          {session.title} · {session.id.slice(0, 8)} · {session.cwd} · {session.updatedAt}
        </Text>
      ))}
    </Box>
  )
}
