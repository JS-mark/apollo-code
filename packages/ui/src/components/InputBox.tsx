import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

export interface InputBoxProps {
  disabled?: boolean
  initialValue?: string
  onSubmit?: (input: string) => Promise<void> | void
  placeholder?: string
}

export function InputBox({
  disabled = false,
  initialValue = '',
  onSubmit,
  placeholder = 'Type a message',
}: InputBoxProps) {
  const [value, setValue] = useState(initialValue)
  useInput(
    (input, key) => {
      if (disabled) return
      if (key.ctrl && input === 'c') {
        void onSubmit?.('/exit')
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const submitted = value
        setValue('')
        void onSubmit?.(submitted)
        return
      }
      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return
      if (input) setValue((current) => current + input)
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
