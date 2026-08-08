import { Box, Text } from 'ink'

import type { WelcomeLayoutMode } from './types'

const mark = ['   ███   ', '  █   █  ', ' ███████ ', ' █     █ ', '█       █']

export function ApolloLogo({ layout }: { layout: WelcomeLayoutMode }) {
  if (layout !== 'full')
    return (
      <Text color="cyan" bold>
        apollo
      </Text>
    )
  return (
    <Box flexDirection="column" marginRight={4}>
      {mark.map((line) => (
        <Text color="cyan" key={line}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
