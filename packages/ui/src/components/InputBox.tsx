import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

export interface InputBoxProps {
  disabled?: boolean
  history?: readonly string[]
  initialValue?: string
  onSubmit?: (input: string) => Promise<void> | void
  placeholder?: string
}

export function InputBox({
  disabled = false,
  history = [],
  initialValue = '',
  onSubmit,
  placeholder = 'Type a message',
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
      if (key.ctrl || key.meta || key.escape || key.tab) return
      if (input) {
        setHistoryIndex(null)
        setValue((current) => current + input)
      }
    },
    { isActive: !disabled },
  )

  return (
    <Box>
      <Text color="green">{'> '}</Text>
      {value ? <Text>{value}</Text> : <Text color="gray">{placeholder}</Text>}
    </Box>
  )
}
