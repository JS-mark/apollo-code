export type WelcomeLayoutMode = 'full' | 'compact' | 'minimal'
export type StatusTone = 'default' | 'info' | 'success' | 'warning' | 'danger' | 'muted'
export type TerminalSize = { columns: number; rows: number }

export interface WelcomeScreenState {
  app: { name: 'Apollo Code'; version: string }
  workspace: { cwd: string; displayCwd: string; trustLabel: string; trustTone: StatusTone }
  provider: { label: string; authLabel: string; authTone: StatusTone }
  sandbox: { label: string; tone: StatusTone }
  permission: { label: string; tone: StatusTone }
  session: { label: string; contextLabel: string; tokensRemainingLabel: string | null }
  agent: { mode: string; status: string; thinking: 'on' | 'off' }
  firstRunChecks: ReadonlyArray<{ id: string; label: string; tone: StatusTone }>
}
