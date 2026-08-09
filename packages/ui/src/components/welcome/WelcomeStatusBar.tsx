import { Box, Text } from 'ink'

import type { WelcomeLayoutMode, WelcomeScreenState } from './types'

export function WelcomeStatusBar({
  layout,
  state,
}: {
  layout: WelcomeLayoutMode
  state: WelcomeScreenState
}) {
  return (
    <Box
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      borderTop
      flexGrow={1}
      paddingX={1}
    >
      <Text color="cyan" inverse>
        {' '}
        mode {state.agent.mode}{' '}
      </Text>
      <Text color="gray"> agent </Text>
      <Text color="green">{state.agent.status}</Text>
      <Text color="gray"> thinking {state.agent.thinking}</Text>
      {layout === 'full' ? (
        <>
          <Text color="gray"> cwd </Text>
          <Text>{state.workspace.displayCwd}</Text>
          <Text color="gray"> tokens </Text>
          <Text>{state.session.tokensRemainingLabel ?? 'unknown'}</Text>
          <Text color="gray"> esc </Text>
          <Text>interrupt</Text>
        </>
      ) : layout === 'compact' ? (
        <>
          <Text color="gray"> esc </Text>
          <Text>interrupt</Text>
        </>
      ) : null}
    </Box>
  )
}
