import { runDoctor } from '../../doctor'
import type { CommandDefinition } from '../../shared/cli-types'

export const doctorCommand: CommandDefinition = {
  name: 'doctor',
  async run({ args, cwd, ports }) {
    const checks = await runDoctor(cwd, ports)
    return {
      exitCode: args.strict && checks.some((check) => !check.ok) ? 1 : 0,
      stdout: args.json
        ? `${JSON.stringify(checks)}\n`
        : `${checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n')}\n`,
      stderr: '',
    }
  },
}
