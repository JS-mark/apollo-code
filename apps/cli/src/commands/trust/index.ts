import type { CommandDefinition } from '../../shared/cli-types'

export const trustCommand: CommandDefinition = {
  name: 'trust',
  async run({ args, ports }) {
    const action = args._[1] ?? 'list'
    if (action === 'list') {
      const rules = await ports.trust.list()
      return {
        exitCode: 0,
        stdout: args.json
          ? `${JSON.stringify(rules)}\n`
          : rules.length
            ? `${rules.map((rule) => `${rule.scope}\t${rule.path}\t${rule.trustedAt}`).join('\n')}\n`
            : 'No trusted directories.\n',
        stderr: '',
      }
    }
    if (action === 'revoke') {
      const target = args._[2]
      if (!target && !args.all)
        return { exitCode: 2, stdout: '', stderr: 'trust revoke requires a path or --all' }
      const removed = args.all ? await ports.trust.revokeAll() : await ports.trust.revoke(target!)
      return {
        exitCode: 0,
        stdout: args.json
          ? `${JSON.stringify({ removed })}\n`
          : `Revoked ${removed} trust rule(s).\n`,
        stderr: '',
      }
    }
    return { exitCode: 2, stdout: '', stderr: `Unknown trust action: ${action}` }
  },
}
