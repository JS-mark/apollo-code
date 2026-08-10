import type { ApolloPorts } from '../ports'

export interface CliResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface CliIo {
  isInteractiveTerminal?(): boolean
  readStdin(): Promise<string>
}

export interface ParsedCliArgs {
  _: string[]
  all?: boolean
  cwd?: string
  json?: boolean
  strict?: boolean
  [key: string]: unknown
}

export interface CommandContext {
  args: ParsedCliArgs
  cwd: string
  ports: ApolloPorts
}

export interface CommandDefinition {
  name: string
  run(context: CommandContext): Promise<CliResult>
}
