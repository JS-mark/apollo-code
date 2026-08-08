import { Box, Text } from 'ink'

import type { WelcomeLayoutMode, WelcomeScreenState } from './types'
import { colorForTone } from './welcomeTheme'

export function FirstRunChecks({
  layout,
  state,
}: {
  layout: WelcomeLayoutMode
  state: WelcomeScreenState
}) {
  if (layout === 'minimal') return null
  return (
    <Box
      flexDirection={layout === 'full' ? 'row' : 'column'}
      gap={layout === 'full' ? 2 : 0}
      marginTop={1}
    >
      {state.firstRunChecks.map((item) => (
        <Text color={colorForTone(item.tone)} key={item.id}>
          ● {item.label}
        </Text>
      ))}
    </Box>
  )
}
