import { Box, Text } from 'ink'

export interface InputBoxProps {
  placeholder?: string
  value?: string
}

export function InputBox({ placeholder = 'Type a message', value = '' }: InputBoxProps) {
  return (
    <Box>
      <Text color="green">{'> '}</Text>
      <Text>{value || placeholder}</Text>
    </Box>
  )
}
