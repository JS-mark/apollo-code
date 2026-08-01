import type { SandboxDisclosure } from '@apollo-code/ui'

export interface DoctorHealth { detail: string; valid?: boolean; configured?: boolean }
export interface NativeHealth { sandbox: boolean; search: boolean; fs: boolean }
export interface SessionPort { start(input: { cwd: string; prompt?: string }): Promise<{ id: string }>; interrupt(): Promise<void>; end(): Promise<void> }
export interface ApolloPorts {
  version: string
  native: { probe(): Promise<SandboxDisclosure>; health(): Promise<NativeHealth> }
  auth: { health(): Promise<DoctorHealth> }
  config: { health(): Promise<DoctorHealth> }
  telemetry: { securityEvent(name: string, payload: Record<string, boolean | string>): Promise<void> }
  confirmation: { confirmDangerousNoSandbox(sentence: string): Promise<boolean> }
  session: SessionPort
}
export function unavailablePorts(): ApolloPorts {
  return {
    version: '0.0.0',
    native: { probe: async () => ({ tier: 'none', mechanism: 'native port not connected', features: { filesystem: false, network: false }, degradationReasons: ['apollo-sandbox probe unavailable'] }), health: async () => ({ sandbox: false, search: false, fs: false }) },
    auth: { health: async () => ({ configured: false, detail: 'auth port not connected' }) },
    config: { health: async () => ({ valid: false, detail: 'config port not connected' }) },
    telemetry: { securityEvent: async () => {} },
    confirmation: { confirmDangerousNoSandbox: async () => false },
    session: { start: async () => ({ id: 'unconnected-session' }), interrupt: async () => {}, end: async () => {} },
  }
}
