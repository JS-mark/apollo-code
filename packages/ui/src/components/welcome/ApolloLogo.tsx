import { Box, Text } from 'ink'

import type { WelcomeLayoutMode } from './types'
import { welcomeTheme } from './welcomeTheme'

export const APOLLO_LOGO_WIDTH = 25

const mark = [
  '       .--------.        ',
  "    .-'    /\\    '-.     ",
  "  .'      /  \\      '.   ",
  ' /       / /\\ \\       \\  ',
  '|       / ____ \\       | ',
  '|      /_/    \\_\\      | ',
  ' \\                  /  ',
  "  '._            _.'   ",
  "     '----------'      ",
] as const

export function ApolloLogo({ layout }: { layout: WelcomeLayoutMode }) {
  if (layout === 'minimal')
    return (
      <Text color={welcomeTheme.brandAccent} bold>
        APOLLO
      </Text>
    )

  if (layout === 'compact')
    return (
      <Box flexDirection="column">
        <Text color={welcomeTheme.brandAccent} bold>
          {' /\\  APOLLO'}
        </Text>
        <Text color={welcomeTheme.brandAccent} bold>
          {'/__\\ CODE'}
        </Text>
      </Box>
    )

  return (
    <Box flexDirection="column" flexShrink={0} marginRight={3} width={APOLLO_LOGO_WIDTH}>
      {mark.map((line) => (
        <Text bold color={welcomeTheme.brandAccent} key={line}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
