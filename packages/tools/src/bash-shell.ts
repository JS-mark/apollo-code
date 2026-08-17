import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * REM-57 (spec 04-tools-permissions.md §4.3.1, r13-I11): pinned shell selection
 * and minimal env inheritance for the Bash tool.
 *
 * - Unix: `/bin/bash -c` is FIXED. `$SHELL` is never read, so user rc side
 *   effects and cross-machine nondeterminism stay out of the contract.
 * - Windows: PowerShell 7+ (`pwsh`) when resolvable, otherwise the command
 *   processor; the `[tools] windows_shell` config key overrides detection.
 * - env inheritance is a minimal set (`PATH`/`HOME`/`LANG`/`TZ`, each omitted
 *   when unset) plus the explicit `[tools] pass_through_env` whitelist. Full
 *   host inheritance is forbidden: secrets must not leak into the sandbox.
 */

/** The one and only Unix shell; selected without consulting `$SHELL`. */
export const PINNED_UNIX_SHELL = '/bin/bash'

/** Env names inherited by default; TZ (and any other) may be omitted when unset. */
export const MINIMAL_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'LANG', 'TZ']

export type ShellQuoting = 'posix' | 'windows'

export interface ShellSelection {
  /** Shell program the sandbox must exec; also added to the sandbox fs read whitelist. */
  program: string
  /** Flag arguments that precede the user command (e.g. `-c`, `-Command`, `/C`). */
  args: string[]
  /** How the user command is quoted when the invocation is flattened to one string. */
  quoting: ShellQuoting
}

export interface ShellSelectionOptions {
  /** `[tools] windows_shell` — replaces pwsh/cmd detection entirely. */
  windowsShell?: string
  /** Resolved PowerShell 7+ path; undefined means PowerShell is absent. */
  pwshPath?: string
  /** Command processor for the cmd fallback; defaults to `cmd.exe` on PATH. */
  commandProcessor?: string
}

function flagArgsFor(program: string): string[] {
  const base = program.split(/[\\/]/).pop() ?? program
  return /cmd/i.test(base) ? ['/C'] : ['-Command']
}

export function selectShell(platform: string, options: ShellSelectionOptions = {}): ShellSelection {
  if (platform !== 'win32') return { program: PINNED_UNIX_SHELL, args: ['-c'], quoting: 'posix' }
  const override = options.windowsShell?.trim()
  if (override) return { program: override, args: flagArgsFor(override), quoting: 'windows' }
  const pwsh = options.pwshPath?.trim()
  if (pwsh) return { program: pwsh, args: ['-Command'], quoting: 'windows' }
  const commandProcessor = options.commandProcessor?.trim() || 'cmd.exe'
  return { program: commandProcessor, args: ['/C'], quoting: 'windows' }
}

/**
 * Resolves PowerShell 7+ (`pwsh`) from a PATH-style environment without ever
 * falling back to Windows PowerShell 5 (`powershell.exe`). Returns undefined
 * when PowerShell is absent, letting `selectShell` fall back to cmd.
 */
export async function resolvePwshPath(
  source: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const path = source.PATH ?? source.Path
  if (!path) return undefined
  for (const dir of path.split(';')) {
    if (!dir) continue
    for (const name of ['pwsh.exe', 'pwsh']) {
      const candidate = join(dir, name)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep scanning
      }
    }
  }
  return undefined
}

/**
 * Builds the sandbox-inherited env: the minimal key set plus the explicit
 * pass-through whitelist. Names match exactly and unset (or empty) variables
 * are never injected.
 */
export function minimalEnv(
  source: Record<string, string | undefined>,
  passThroughEnv: readonly string[] = [],
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const key of [...MINIMAL_ENV_KEYS, ...passThroughEnv]) {
    const value = source[key]
    if (value !== undefined && value !== '') inherited[key] = value
  }
  return inherited
}

/**
 * Quotes the user command so the flattened invocation
 * (`<program> <flags...> <quoted>` run under the sandbox's outer shell) still
 * delivers the command as a single argument to the selected shell.
 */
export function quoteShellArgument(command: string, quoting: ShellQuoting): string {
  return quoting === 'posix'
    ? `'${command.replaceAll("'", `'\\''`)}'`
    : `"${command.replaceAll('"', '\\"')}"`
}
