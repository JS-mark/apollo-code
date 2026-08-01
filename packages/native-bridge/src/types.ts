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
export interface ExecResult { stdout: string; stderr: string; exit_code: number; duration_ms: number; sandbox_tier: SandboxTier; sandbox_violations: string[] }
