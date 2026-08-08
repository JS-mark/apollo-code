import { Text } from 'ink'
import type { PropsWithChildren } from 'react'

export type StatusLevel = 'active' | 'error' | 'muted' | 'warning'

export interface StatusLineProps extends PropsWithChildren {
  level?: StatusLevel
}

export function StatusLine({ children, level = 'muted' }: StatusLineProps) {
  return <Text color={statusColor(level)}>{children}</Text>
}

function statusColor(level: StatusLevel) {
  if (level === 'active') return 'cyan'
  if (level === 'error') return 'red'
  if (level === 'warning') return 'yellow'
  return 'gray'
}
