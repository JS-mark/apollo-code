import { Box, Text } from 'ink'

import { welcomeTheme } from './welcomeTheme'

export const APOLLO_LOGO_WIDTH = 22

const mark = [
  ['antenna-top', '    ████      ████    '],
  ['antenna-base', '    ████      ████    '],
  ['head', '██████████████████████'],
  ['face-top', '████              ████'],
  ['eyes', '████   ██    ██   ████'],
  ['eyes-base', '████   ██    ██   ████'],
  ['face-bottom', '████              ████'],
  ['base', '    ██████████████    '],
] as const

export function ApolloLogo() {
  return (
    <Box flexDirection="column" flexShrink={0} marginRight={3} width={APOLLO_LOGO_WIDTH}>
      {mark.map(([id, line]) => (
        <Text bold color={welcomeTheme.brandAccent} key={id}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
