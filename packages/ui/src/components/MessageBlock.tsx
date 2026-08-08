import { Box, Text } from 'ink'

import type { TranscriptEntry } from '../app'

export interface MessageBlockProps {
  entry: TranscriptEntry
}

export function MessageBlock({ entry }: MessageBlockProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={roleColor(entry.role)}>{roleLabel(entry.role)}</Text>
      <Text>{entry.text}</Text>
    </Box>
  )
}

function roleLabel(role: TranscriptEntry['role']) {
  if (role === 'assistant') return 'assistant'
  if (role === 'user') return 'you'
  return 'system'
}

function roleColor(role: TranscriptEntry['role']) {
  if (role === 'assistant') return 'cyan'
  if (role === 'user') return 'green'
  return 'gray'
}
