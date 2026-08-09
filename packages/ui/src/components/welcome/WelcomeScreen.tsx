import { Box, Text } from 'ink'

import { ApolloLogo } from './ApolloLogo'
import { FirstRunChecks } from './FirstRunChecks'
import type { WelcomeScreenProps } from './types'
import { getWelcomeLayout } from './welcomeLayout'
import { WelcomeStatusBar } from './WelcomeStatusBar'
import { WelcomeStatusGrid } from './WelcomeStatusGrid'

export function WelcomeScreen({
  bottomStatus,
  commandInput,
  state,
  terminalSize,
}: WelcomeScreenProps) {
  const layout = getWelcomeLayout(terminalSize)
  return (
    <Box borderColor="cyan" borderStyle="single" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>{`Apollo Code  v${state.app.version}`}</Text>
        <Text color="gray">WELCOME / {layout.toUpperCase()}</Text>
      </Box>
      <Box
        alignItems={layout === 'full' ? 'flex-start' : undefined}
        flexDirection={layout === 'full' ? 'row' : 'column'}
        marginTop={1}
      >
        <ApolloLogo layout={layout} />
        <WelcomeStatusGrid layout={layout} state={state} />
      </Box>
      <FirstRunChecks layout={layout} state={state} />
      <Box marginTop={1}>
        <WelcomeStatusBar layout={layout} state={state} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">COMMAND</Text>
        {commandInput}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="gray">BOTTOM STATUS</Text>
        {bottomStatus}
      </Box>
    </Box>
  )
}
