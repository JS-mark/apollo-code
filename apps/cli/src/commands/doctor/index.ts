import { runDoctor } from '../../doctor'
import type { DoctorCheck } from '../../doctor'
import type { CommandDefinition } from '../../shared/cli-types'

function iconFor(check: DoctorCheck): string {
  if (check.warn === true) return '⚠️'
  return check.ok ? '✓' : '✗'
}

export const doctorCommand: CommandDefinition = {
  name: 'doctor',
  async run({ args, cwd, ports }) {
    const checks = await runDoctor(cwd, ports)
    return {
      exitCode: args.strict && checks.some((check) => !check.ok) ? 1 : 0,
      stdout: args.json
        ? `${JSON.stringify(checks)}\n`
        : `${checks.map((check) => `${iconFor(check)} ${check.name}: ${check.detail}`).join('\n')}\n`,
      stderr: '',
    }
  },
}
