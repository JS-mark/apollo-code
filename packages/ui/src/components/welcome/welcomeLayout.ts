import type { TerminalSize, WelcomeLayoutMode } from './types'

export function getWelcomeLayout(size: TerminalSize): WelcomeLayoutMode {
  if (size.columns < 80 || size.rows < 20) return 'minimal'
  if (size.columns < 110 || size.rows < 28) return 'compact'
  return 'full'
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength < 2) return value.slice(0, Math.max(0, maxLength))
  if (value.length <= maxLength) return value
  const left = Math.ceil((maxLength - 1) / 2)
  return `${value.slice(0, left)}…${value.slice(value.length - (maxLength - left - 1))}`
}

export function formatDisplayCwd(cwd: string, homeDir?: string, maxLength = 48): string {
  const display =
    homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))
      ? `~${cwd.slice(homeDir.length)}`
      : cwd
  return truncateMiddle(display, maxLength)
}
