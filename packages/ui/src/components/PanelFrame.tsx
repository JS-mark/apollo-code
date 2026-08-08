import { Box, Text } from 'ink'
import type { PropsWithChildren } from 'react'

export interface PanelFrameProps extends PropsWithChildren {
  footer?: string
  title: string
}

export function PanelFrame({ children, footer, title }: PanelFrameProps) {
  return (
    <Box
      borderColor="gray"
      borderStyle="single"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
      {footer ? (
        <Box marginTop={1}>
          <Text color="gray">{footer}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
