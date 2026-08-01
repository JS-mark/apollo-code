import { validateWorkspacePath } from '@apollo-code/shared'
import {
  renderPrivacyDisclosure,
  renderSandboxDisclosure,
  renderSecurityBanner,
} from '@apollo-code/ui'
import type { DangerousMode } from '@apollo-code/ui'
import { parseArgs, renderUsage } from 'citty'

import { command } from './command'
import { runDoctor } from './doctor'
import type { ApolloPorts } from './ports'

export interface CliResult {
  exitCode: number
  stderr: string
  stdout: string
}
const argsDefinition = {
  cwd: { type: 'string' as const },
  json: { type: 'boolean' as const },
  noColor: { type: 'boolean' as const },
  noTui: { type: 'boolean' as const },
  strict: { type: 'boolean' as const },
  strictSandbox: { type: 'boolean' as const },
  dangerousNoSandbox: { type: 'boolean' as const },
  dangerouslySkipPermissions: { type: 'boolean' as const },
  yolo: { type: 'boolean' as const },
  apiKeyStdin: { type: 'boolean' as const },
  skipVerify: { type: 'boolean' as const },
  dangerous: { type: 'boolean' as const },
}
export interface CliIo {
  readStdin(): Promise<string>
}
const defaultIo: CliIo = {
  async readStdin() {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  },
}
export async function runCli(
  rawArgs: string[],
  ports: ApolloPorts,
  io: CliIo = defaultIo,
): Promise<CliResult> {
  const args = parseArgs(rawArgs, argsDefinition)
  const subcommand = args._[0]
  let stdout = ''
  let stderr = ''
  let cwd: string
  try {
    cwd = await validateWorkspacePath(String(args.cwd ?? process.cwd()))
  } catch (error) {
    return { exitCode: 1, stdout, stderr: error instanceof Error ? error.message : String(error) }
  }
  const dangerousModes: DangerousMode[] = []
  if (args.yolo || args.dangerouslySkipPermissions) {
    dangerousModes.push('skip-permissions')
    await ports.telemetry.securityEvent('permissions.dangerously_skipped', { cwd })
  }
  if (args.dangerousNoSandbox) {
    dangerousModes.push('no-sandbox')
    await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
    if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
      return {
        exitCode: 1,
        stdout,
        stderr: 'Dangerous no-sandbox mode requires typing: I understand the risk',
      }
  }
  const probe = await ports.native.probe()
  const startsSession = subcommand === undefined || subcommand === 'chat'
  if (startsSession) stdout += `${renderPrivacyDisclosure()}\n`
  stdout += `${renderSandboxDisclosure(probe)}\n`
  if (args.strictSandbox && probe.tier !== 'full')
    return { exitCode: 3, stdout, stderr: `Full sandbox required; detected ${probe.tier}.` }
  if (startsSession && probe.tier === 'none' && !args.dangerousNoSandbox) {
    await ports.telemetry.securityEvent('sandbox.probe.failed', { cwd, mechanism: probe.mechanism })
    if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
      return {
        exitCode: 1,
        stdout,
        stderr: 'None-tier sandbox requires typing: I understand the risk',
      }
    dangerousModes.push('no-sandbox')
    await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
  }
  const banner = renderSecurityBanner(dangerousModes, !args.noColor)
  if (banner) stdout += `${banner}\n`
  ports.session.configureSecurity?.({
    skipPermissions: Boolean(args.yolo || args.dangerouslySkipPermissions),
  })
  if (subcommand === 'doctor') {
    const checks = await runDoctor(cwd, ports)
    stdout += args.json
      ? `${checks.map((check) => JSON.stringify(check)).join('\n')}\n`
      : `${checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`).join('\n')}\n`
    return { exitCode: args.strict && checks.some((check) => !check.ok) ? 1 : 0, stdout, stderr }
  }
  if (subcommand === 'version')
    return { exitCode: 0, stdout: `${stdout}${ports.version}\n`, stderr }
  if (subcommand === 'help')
    return { exitCode: 0, stdout: `${stdout}${await renderUsage(command)}`, stderr }
  if (subcommand === 'hook' && args._[1] === 'list')
    return { exitCode: 0, stdout: `${stdout}No builtin hooks registered.\n`, stderr }
  if (subcommand === 'resume') {
    const id = args._[1]
    if (!id) return { exitCode: 2, stdout, stderr: 'resume requires a session id' }
    await ports.session.resume(id)
    return { exitCode: 0, stdout, stderr }
  }
  if (subcommand === 'login') {
    const provider = args._[1] ?? 'anthropic'
    if (provider !== 'anthropic')
      return { exitCode: 2, stdout, stderr: `Unsupported provider: ${provider}` }
    if (args.skipVerify && !args.dangerous)
      return { exitCode: 2, stdout, stderr: '--skip-verify requires --dangerous' }
    const credential = args.apiKeyStdin ? (await io.readStdin()).trim() : undefined
    if (args.apiKeyStdin && !credential)
      return { exitCode: 2, stdout, stderr: 'No credential received on stdin' }
    try {
      const result = await ports.auth.login({
        provider,
        ...(credential === undefined ? {} : { credential }),
        flow: args.apiKeyStdin ? 'stdin' : 'api-key',
        dangerouslySkipVerify: Boolean(args.skipVerify),
      })
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Login failed',
      }
    }
  }
  if (subcommand === 'logout') {
    const provider = args._[1] ?? 'anthropic'
    try {
      const result = await ports.auth.logout(provider)
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Logout failed',
      }
    }
  }
  if (subcommand !== undefined && subcommand !== 'chat')
    return {
      exitCode: 2,
      stdout,
      stderr: `${subcommand} integration port is not connected in the L1 shell.`,
    }
  const prompt = subcommand === 'chat' ? args._.slice(1).join(' ') : args._.join(' ') || undefined
  await ports.session.start({ cwd, ...(prompt === undefined ? {} : { prompt }) })
  return { exitCode: 0, stdout, stderr }
}
