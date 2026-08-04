export type SandboxTier = 'full' | 'partial' | 'weak' | 'none'
export interface SandboxInfo {
  platform: string
  arch: string
  libc: 'gnu' | 'musl' | null
  os_version: string
  tier: SandboxTier
  features: Readonly<Record<string, unknown>>
  known_limitations: readonly string[]
}
export interface ExecOptions {
  command: string
  cwd: string
  timeout_ms?: number
  permissions: { fs: { read: string[]; write: string[] }; net: boolean; env: { read: string[] } }
  env?: Record<string, string>
}
export interface ExecResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
  sandbox_tier: SandboxTier
  sandbox_violations: string[]
}
export interface PluginSandboxProfile {
  fs: { read: string[]; write: string[] }
  net: false | { allowlist: string[] }
  env: { read: string[] }
  limits: { cpu_seconds: number; rss_mb: number; processes: number; open_files: number }
}
export interface PluginHostOptions {
  entry: string
  dataDir: string
  profile: PluginSandboxProfile
  activationTimeoutMs?: number
  signal?: AbortSignal
}
export interface PluginHost {
  readonly pid: number
  readonly bridge: NodeJS.ReadWriteStream
  terminate(): void
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}
