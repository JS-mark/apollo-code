import { VolundError } from '@volund/shared'

import type { CommandContext, CommandDefinition, CliResult } from '../shared/cli-types'

export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>()

  constructor(commands: readonly CommandDefinition[]) {
    for (const command of commands) {
      if (this.#commands.has(command.name))
        throw new VolundError('cli_internal', `Duplicate command: ${command.name}`)
      this.#commands.set(command.name, command)
    }
  }

  has(name: string): boolean {
    return this.#commands.has(name)
  }

  async dispatch(name: string, context: CommandContext): Promise<CliResult> {
    const command = this.#commands.get(name)
    if (!command) throw new VolundError('cli_internal', `Unknown command: ${name}`)
    return command.run(context)
  }
}
