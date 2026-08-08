import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import type { SlashCommand } from '../app'

export interface InputBoxProps {
  disabled?: boolean
  history?: readonly string[]
  initialValue?: string
  onSubmit?: (input: string) => Promise<void> | void
  placeholder?: string
  slashCommands?: readonly SlashCommand[]
}

export function InputBox({
  disabled = false,
  history = [],
  initialValue = '',
  onSubmit,
  placeholder = 'Type a message',
  slashCommands = [],
}: InputBoxProps) {
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [value, setValue] = useState(initialValue)
  useInput(
    (input, key) => {
      if (disabled) return
      if (key.upArrow) {
        if (history.length === 0) return
        const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        if (historyIndex === null) setDraftBeforeHistory(value)
        setHistoryIndex(nextIndex)
        setValue(history[nextIndex] ?? '')
        return
      }
      if (key.downArrow) {
        if (historyIndex === null) return
        const nextIndex = historyIndex + 1
        if (nextIndex >= history.length) {
          setHistoryIndex(null)
          setValue(draftBeforeHistory)
        } else {
          setHistoryIndex(nextIndex)
          setValue(history[nextIndex] ?? '')
        }
        return
      }
      if (key.ctrl && input === 'c') {
        void onSubmit?.('/exit')
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const submitted = value
        setHistoryIndex(null)
        setDraftBeforeHistory('')
        setValue('')
        void onSubmit?.(submitted)
        return
      }
      if (key.backspace || key.delete) {
        setHistoryIndex(null)
        setValue((current) => current.slice(0, -1))
        return
      }
      if (key.tab) {
        const [first] = slashSuggestions(value, slashCommands)
        if (first) setValue(`/${first.name} `)
        return
      }
      if (key.ctrl || key.meta || key.escape) return
      if (input) {
        setHistoryIndex(null)
        setValue((current) => current + input)
      }
    },
    { isActive: !disabled },
  )

  const suggestions = slashSuggestions(value, slashCommands)

  return (
    <Box borderColor={disabled ? 'gray' : 'cyan'} borderStyle="single" paddingX={1}>
      <Box flexDirection="column" width="100%">
        <Box>
          <Text color={disabled ? 'gray' : 'cyan'} bold>
            apollo
          </Text>
          <Text color={disabled ? 'gray' : 'green'}>{' > '}</Text>
          {value ? <Text>{value}</Text> : <Text color="gray">{placeholder}</Text>}
        </Box>
        {suggestions.length > 0 ? (
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {suggestions.map((command) => (
              <Text color={command.available === false ? 'gray' : 'cyan'} key={command.name}>
                /{command.name} {command.description}
                {command.available === false ? ' (not available)' : ''}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

function slashSuggestions(value: string, commands: readonly SlashCommand[]) {
  if (!value.startsWith('/') || value.includes(' ')) return []
  const prefix = value.slice(1).toLowerCase()
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix)).slice(0, 6)
}
