import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'

import {
  createSessionPickerState,
  filterSessions,
  formatSessionTime,
  sessionPickerPage,
  sessionPickerKey,
  type SessionCandidate,
} from '../session-picker'

export function SessionPicker(props: {
  sessions: readonly SessionCandidate[]
  error?: string
  now?: number
  pageSize?: number
  placeholder?: string
  onCancel(): void
  onSelect(session: SessionCandidate): void
}) {
  const [state, setState] = useState(() => createSessionPickerState(props.sessions))
  const pageSize = props.pageSize ?? 10
  const filtered = useMemo(
    () => filterSessions(state.sessions, state.query),
    [state.sessions, state.query],
  )
  const page = sessionPickerPage(filtered, state.selected, pageSize)
  useInput((input, key) => {
    const name = key.escape
      ? 'Escape'
      : key.return
        ? 'Enter'
        : key.upArrow
          ? 'ArrowUp'
          : key.downArrow
            ? 'ArrowDown'
            : key.pageUp
              ? 'PageUp'
              : key.pageDown
                ? 'PageDown'
                : key.home
                  ? 'Home'
                  : key.end
                    ? 'End'
                    : key.backspace || key.delete
                      ? 'Backspace'
                      : input
    const action = sessionPickerKey(state, name, pageSize)
    if (action.type === 'cancel') props.onCancel()
    else if (action.type === 'select') props.onSelect(action.session)
    else setState(action.state)
  })
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>Resume session</Text>
      <Box
        borderBottom
        borderColor="cyan"
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        borderTop
        paddingX={1}
        width="100%"
      >
        <Text color="green">{'> '}</Text>
        {state.query ? (
          <Text>{state.query}</Text>
        ) : (
          <>
            <Text color="cyan">▌</Text>
            <Text color="gray">
              {props.placeholder ?? 'Search sessions by title, path, summary, or ID'}
            </Text>
          </>
        )}
      </Box>
      <Text dimColor>
        ↑/↓ select · PgUp/PgDn page · Home/End first/last · Enter resume · Esc cancel
      </Text>
      {props.error ? <Text color="red">{props.error}</Text> : null}
      {!state.sessions.length ? <Text>No saved sessions.</Text> : null}
      {state.sessions.length && !filtered.length ? (
        <Text>No sessions match “{state.query}”.</Text>
      ) : null}
      {page.items.map((session, index) => {
        const absoluteIndex = page.start + index
        return (
          <Text
            key={session.id}
            {...(absoluteIndex === state.selected ? { color: 'cyan' as const } : {})}
          >
            {absoluteIndex === state.selected ? '› ' : '  '}
            {session.title} · {formatSessionTime(session.updatedAt, props.now)} · {session.cwd} ·{' '}
            {session.id.slice(0, 8)}
          </Text>
        )
      })}
      {filtered.length ? (
        <Text dimColor>
          Showing {page.start + 1}–{page.end} of {page.total}
        </Text>
      ) : null}
    </Box>
  )
}
