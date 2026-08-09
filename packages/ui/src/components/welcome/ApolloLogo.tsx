import { Box, Text } from 'ink'

import { welcomeTheme } from './welcomeTheme'

export const APOLLO_LOGO_WIDTH = 24

const mark = [
  ['portrait-1', '        ⢠⣴⣦⣄⣤⡀'],
  ['portrait-2', '       ⢀⣵⣾⣶⡶⣿⣧⡀'],
  ['portrait-3', '      ⢠⣿⡿⣛⣼⣿⠿⣿⠁'],
  ['portrait-4', '      ⣘⠇⣈⢿⣿⣿⣿⡿'],
  ['portrait-5', '      ⡽⣶⢩⣿⣿⣿⣿⡇'],
  ['portrait-6', '      ⠐⣭⠸⣿⣿⣯⣉⠁ ⣀'],
  ['portrait-7', '      ⢀⡄⣠⣿⣿⣿⣿⣷⣿⣽⣛⡷⠖'],
  ['portrait-8', '    ⠠⣶⣛⣽⣿⣿⣿⣿⣿⣿⠿⢟⡫'],
  ['portrait-9', '       ⠉⠛⠻⠟⠯⠝⠓⠊⠉'],
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
