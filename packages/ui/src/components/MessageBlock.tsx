import { Box, Text } from 'ink'

import type { TranscriptEntry } from '../app'

export interface MessageBlockProps {
  entry: TranscriptEntry
}

export function MessageBlock({ entry }: MessageBlockProps) {
  if (entry.role === 'assistant') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          APOLLO
        </Text>
        <Box borderColor="gray" borderStyle="single" flexDirection="column" paddingX={1}>
          <Text wrap="wrap">{entry.text}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={roleColor(entry.role)} bold>
        {roleLabel(entry.role)}
      </Text>
      <Box paddingLeft={2}>
        {entry.role === 'system' ? (
          <Text color="gray" wrap="wrap">
            {entry.text}
          </Text>
        ) : (
          <Text wrap="wrap">{entry.text}</Text>
        )}
      </Box>
    </Box>
  )
}

function roleLabel(role: TranscriptEntry['role']) {
  if (role === 'assistant') return 'APOLLO'
  if (role === 'user') return 'YOU'
  return 'SYSTEM'
}

function roleColor(role: TranscriptEntry['role']) {
  if (role === 'assistant') return 'cyan'
  if (role === 'user') return 'green'
  return 'gray'
}
