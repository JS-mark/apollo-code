import { Box, Text } from 'ink'

import type { TranscriptEntry } from '../app'
import { MessageBlock } from './MessageBlock'

export interface ScrollableTranscriptProps {
  entries: readonly TranscriptEntry[]
  maxItems?: number
}

export function ScrollableTranscript({ entries, maxItems = 16 }: ScrollableTranscriptProps) {
  const visibleEntries = entries.slice(-maxItems)
  return (
    <Box flexDirection="column" minHeight={1} marginBottom={1}>
      {visibleEntries.length === 0 ? (
        <Box borderColor="gray" borderStyle="single" paddingX={1}>
          <Text color="gray">Ready. Start with a message or /help.</Text>
        </Box>
      ) : (
        visibleEntries.map((entry) => <MessageBlock entry={entry} key={entry.id} />)
      )}
    </Box>
  )
}
