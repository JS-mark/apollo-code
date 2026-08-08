import { Box, Text } from 'ink'

import { ApolloLogo } from './ApolloLogo'
import { FirstRunChecks } from './FirstRunChecks'
import type { TerminalSize, WelcomeScreenState } from './types'
import { getWelcomeLayout } from './welcomeLayout'
import { WelcomeStatusBar } from './WelcomeStatusBar'
import { WelcomeStatusGrid } from './WelcomeStatusGrid'

export function WelcomeScreen({
  state,
  terminalSize,
}: {
  state: WelcomeScreenState
  terminalSize: TerminalSize
}) {
  const layout = getWelcomeLayout(terminalSize)
  return (
    <Box borderColor="cyan" borderStyle="single" flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>{`Apollo Code  v${state.app.version}`}</Text>
      <Box flexDirection={layout === 'full' ? 'row' : 'column'} marginTop={1}>
        <ApolloLogo layout={layout} />
        <WelcomeStatusGrid layout={layout} state={state} />
      </Box>
      <FirstRunChecks layout={layout} state={state} />
      <Box marginTop={1}>
        <WelcomeStatusBar layout={layout} state={state} />
      </Box>
    </Box>
  )
}
