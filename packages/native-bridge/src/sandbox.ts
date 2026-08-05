import { spawn } from 'node:child_process'

import { resolveBinary } from './resolver'
import type { ExecOptions, ExecResult, PluginHost, PluginHostOptions, SandboxInfo } from './types'

const NONE: SandboxInfo = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  libc: process.platform === 'linux' ? 'gnu' : null,
  os_version: '',
  tier: 'none',
  features: Object.freeze({}),
  known_limitations: Object.freeze(['sandbox binary unavailable']),
})
let frozenProbe: Promise<Readonly<SandboxInfo>> | undefined

function invoke(
  binary: string,
  args: string[],
  input: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], signal })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || `sandbox exited ${code}`))
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
      return Object.freeze({
        ...parsed,
        features: Object.freeze({ ...parsed.features }),
        known_limitations: Object.freeze([...parsed.known_limitations]),
      })
    } catch {
      return NONE
    }
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

/** The only supported plugin process entrypoint. The inherited fd 3 is an NDJSON bridge. */
export async function startPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const info = await probeSandbox()
  if (info.tier === 'none') throw new Error('sandbox unavailable; refusing unsandboxed plugin host')
  const binary = await resolveBinary('sandbox')
  if (!binary) throw new Error('sandbox binary disappeared after frozen probe; restart required')
  const child = spawn(
    binary,
    [
      '--run-plugin',
      '--entry',
      options.entry,
      '--data-dir',
      options.dataDir,
      '--sandbox-profile',
      JSON.stringify(options.profile),
      '--bridge-fd',
      '3',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], signal: options.signal },
  )
  const bridge = child.stdio[3]
  if (!bridge || typeof bridge === 'string') {
    child.kill('SIGKILL')
    throw new Error('plugin bridge fd unavailable')
  }
  // Plugin stdout is never a protocol channel. Drain bounded stderr for
  // diagnostics without allowing an untrusted plugin to fill parent memory.
  child.stdout?.resume()
  let stderrBytes = 0
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > 256 * 1024) child.kill('SIGKILL')
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  )
  const timeout = setTimeout(() => child.kill('SIGKILL'), options.activationTimeoutMs ?? 10_000)
  bridge.once('data', () => clearTimeout(timeout))
  child.once('close', () => clearTimeout(timeout))
  return {
    pid: child.pid ?? -1,
    bridge: bridge as unknown as NodeJS.ReadWriteStream,
    terminate: () => {
      bridge.destroy()
      child.kill('SIGKILL')
    },
    exited,
  }
}
