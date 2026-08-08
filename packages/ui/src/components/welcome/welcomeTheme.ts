import type { StatusTone } from './types'

export const welcomeTheme = {
  brand: 'cyan',
  border: 'cyan',
  default: 'white',
  info: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
} as const

export function colorForTone(tone: StatusTone) {
  return welcomeTheme[tone]
}
