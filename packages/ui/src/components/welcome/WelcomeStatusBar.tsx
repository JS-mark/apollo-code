import { Box, Text } from 'ink'

import type { WelcomeLayoutMode, WelcomeScreenState } from './types'

export function WelcomeStatusBar({
  layout,
  state,
}: {
  layout: WelcomeLayoutMode
  state: WelcomeScreenState
}) {
  const trailing =
    layout === 'minimal'
      ? ''
      : `  cwd ${state.workspace.displayCwd}  tokens ${state.session.tokensRemainingLabel ?? 'unknown'}`
  return (
    <Box>
      <Text color="cyan" inverse>
        {' '}
        {state.agent.mode}{' '}
      </Text>
      <Text color="gray"> agent </Text>
      <Text color="green">{state.agent.status}</Text>
      <Text color="gray">
        {' '}
        thinking {state.agent.thinking}
        {trailing}
      </Text>
    </Box>
  )
}
