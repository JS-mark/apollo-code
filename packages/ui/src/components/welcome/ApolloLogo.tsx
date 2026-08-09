import { Box, Text } from 'ink'

import { welcomeTheme } from './welcomeTheme'

export const APOLLO_LOGO_WIDTH = 24

const mark = [
  ['top-knot', '     ▄▄████▄'],
  ['crown-curls', '   ▄██████████▄'],
  ['hair-profile', ' ▄███▀▄▀▀▀██████'],
  ['brow-profile', '██▀  ▄█    ▀████'],
  ['nose-profile', '██   ▀█▄      ██▌'],
  ['jaw-profile', '▀██▄     ▀▀▄███▀'],
  ['neck-curls', ' ▀███▄▄▄████▀'],
  ['neck', ' ▄▄▀██████▄'],
  ['draped-shoulders', '████▄▄████████▄'],
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
