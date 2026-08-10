import { statusPanelFromWelcome } from '@apollo-code/ui'
import type { StatusPanelData, WelcomePanelData } from '@apollo-code/ui'

import type { CommandDefinition } from '../../shared/cli-types'

export interface StatusPresentation {
  buildFallback(cwd: string): Promise<WelcomePanelData>
  renderText(data: StatusPanelData): string
}

export function createStatusCommand(presentation: StatusPresentation): CommandDefinition {
  return {
    name: 'status',
    async run({ args, cwd, ports }) {
      const data = ports.config.status
        ? await ports.config.status({ cwd })
        : statusPanelFromWelcome(await presentation.buildFallback(cwd))
      return {
        exitCode: 0,
        stdout: args.json ? `${JSON.stringify(data)}\n` : presentation.renderText(data),
        stderr: '',
      }
    },
  }
}
