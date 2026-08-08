import { Box, Text } from 'ink'

export interface TopBarProps {
  cwd: string
  sessionId: string
  status: string
}

export function TopBar({ cwd, sessionId, status }: TopBarProps) {
  return (
    <Box justifyContent="space-between">
      <Text bold>Apollo</Text>
      <Text color="gray">
        {shortSessionId(sessionId)} {cwd} {status}
      </Text>
    </Box>
  )
}

function shortSessionId(sessionId: string) {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}
