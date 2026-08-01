import { spawn } from 'node:child_process'
import type { ExecOptions, ExecResult, SandboxInfo } from './types.js'
import { resolveBinary } from './resolver.js'

const NONE: SandboxInfo = Object.freeze({ platform: process.platform, arch: process.arch, libc: process.platform === 'linux' ? 'gnu' : null, os_version: '', tier: 'none', features: Object.freeze({}), known_limitations: Object.freeze(['sandbox binary unavailable']) })
let frozenProbe: Promise<Readonly<SandboxInfo>> | undefined

function invoke(binary: string, args: string[], input: string | undefined, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], signal })
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      code === 0 ? resolve(Buffer.concat(stdout).toString('utf8')) : reject(new Error(Buffer.concat(stderr).toString('utf8') || `sandbox exited ${code}`))
    })
    child.stdin.end(input)
  })
}

export function probeSandbox(): Promise<Readonly<SandboxInfo>> {
  frozenProbe ??= (async () => {
    const binary = await resolveBinary('sandbox')
    if (!binary) return NONE
    try {
      const parsed = JSON.parse(await invoke(binary, ['--probe'], undefined)) as SandboxInfo
      return Object.freeze({ ...parsed, features: Object.freeze({ ...parsed.features }), known_limitations: Object.freeze([...parsed.known_limitations]) })
    } catch { return NONE }
  })()
  return frozenProbe
}

export async function execSandbox(options: ExecOptions, signal?: AbortSignal): Promise<ExecResult> {
  const info = await probeSandbox()
  if (info.tier === 'none') throw new Error('sandbox unavailable; refusing unsandboxed execution')
  const binary = await resolveBinary('sandbox')
  if (!binary) throw new Error('sandbox binary disappeared after frozen probe; restart required')
  return JSON.parse(await invoke(binary, ['exec'], JSON.stringify(options), signal)) as ExecResult
}
