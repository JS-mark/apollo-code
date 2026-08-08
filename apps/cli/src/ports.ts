import type { EventBus } from '@apollo-code/core'
import type { TelemetryHealth, TelemetrySummary } from '@apollo-code/telemetry'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  InteractiveAppHandle,
  InteractiveAppOptions,
  SandboxDisclosure,
  StatusViewModel,
  SubmitOptions,
} from '@apollo-code/ui'

export interface DoctorHealth {
  detail: string
  valid?: boolean
  configured?: boolean
}
export interface NativeHealth {
  sandbox: boolean
  search: boolean
  fs: boolean
}
export interface SessionPort {
  start(input: { cwd: string; prompt?: string }): Promise<{ id: string; exitCode?: number }>
  startInteractive?(input: { cwd: string }): Promise<InteractiveSession>
  resume(id: string): Promise<{ id: string }>
  interrupt(): Promise<void>
  end(): Promise<void>
  configureSecurity?(input: { skipPermissions: boolean }): void
  configureOutput?(input: { json: boolean; write: (value: string) => void }): void
  configureTerminalOutput?(input: { streamToStdout: boolean }): void
}
export interface InteractiveSession {
  id: string
  events: EventBus
  getStatus?(): Promise<StatusViewModel>
  setPermissionPromptHandler?(
    handler:
      | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
      | undefined,
  ): void
  submit(input: string, options?: SubmitOptions): Promise<void>
  end(): Promise<void>
  exitCode(): number
}
export interface UiPort {
  renderInteractiveApp(options: InteractiveAppOptions): InteractiveAppHandle
}
export interface ContextStatus {
  policy: string
  currentTokens: number
  maxTokens: number
  threshold: number
  sources: Record<string, number>
  lastCompaction?: { compactedMessageIds: string[]; at: string }
}
export interface ContextPort {
  show(): Promise<ContextStatus>
  keep(target: string): Promise<void>
  unkeep(target: string): Promise<void>
  compact(strategy?: 'sliding' | 'summary'): Promise<{ beforeTokens: number; afterTokens: number }>
  getPolicy(): Promise<{ name: string; params: Record<string, boolean | number | string> }>
  setPolicy(name: string, params: Record<string, string>): Promise<void>
}
export interface EvolutionPort {
  show(options: { namespace?: string; since?: Date }): Promise<unknown[]>
  rollback(options: {
    namespace?: 'context' | 'router' | 'retry' | 'tool-timeout'
    to?: Date
  }): Promise<unknown[]>
}
export interface McpPort {
  list(): Promise<Array<{ name: string; transport: string }>>
  test(name: string, signal: AbortSignal): Promise<{ protocolVersion: string }>
  inspect(
    name: string,
    signal: AbortSignal,
  ): Promise<{ tools: Array<{ name: string; description?: string }> }>
}
export interface PluginPort {
  install(source: string): Promise<{ name: string; version: string }>
  uninstall(name: string): Promise<void>
  list(): Promise<Record<string, { version: string; enabled: boolean; failures?: number }>>
  setEnabled(name: string, enabled: boolean): Promise<void>
  doctor(name: string): Promise<{ name: string; version: string; permissions: readonly string[] }>
}
export interface ApolloPorts {
  version: string
  native: { probe(): Promise<SandboxDisclosure>; health(): Promise<NativeHealth> }
  auth: {
    health(): Promise<DoctorHealth>
    login(input: {
      provider: string
      credential?: string
      flow: 'api-key' | 'stdin'
      dangerouslySkipVerify: boolean
    }): Promise<{ detail: string }>
    logout(provider: string): Promise<{ detail: string }>
  }
  config: { health(cwd: string): Promise<DoctorHealth> }
  telemetry: {
    securityEvent(name: string, payload: Record<string, boolean | string>): Promise<void>
    summary(): Promise<TelemetrySummary>
    export(target: string): Promise<number>
    clear(): Promise<void>
    health(): Promise<TelemetryHealth>
  }
  confirmation: { confirmDangerousNoSandbox(sentence: string): Promise<boolean> }
  session: SessionPort
  restore?: {
    restore(
      sessionId: string,
      options: { dryRun: boolean },
    ): Promise<{ restored: string[]; conflicts: string[]; missing: boolean; dryRun: boolean }>
  }
  context?: ContextPort
  evolution?: EvolutionPort
  mcp?: McpPort
  plugin?: PluginPort
  ui?: UiPort
}
export function unavailablePorts(): ApolloPorts {
  return {
    version: '0.0.0',
    native: {
      probe: async () => ({
        tier: 'none',
        mechanism: 'native port not connected',
        features: { filesystem: false, network: false },
        degradationReasons: ['apollo-sandbox probe unavailable'],
      }),
      health: async () => ({ sandbox: false, search: false, fs: false }),
    },
    auth: {
      health: async () => ({ configured: false, detail: 'auth port not connected' }),
      login: async () => {
        throw new Error('auth port not connected')
      },
      logout: async () => {
        throw new Error('auth port not connected')
      },
    },
    config: { health: async () => ({ valid: false, detail: 'config port not connected' }) },
    telemetry: {
      securityEvent: async () => {},
      summary: async () => ({
        samples: 0,
        corruptLines: 0,
        tiers: {},
        escape: { allow: 0, deny: 0, ratio: null },
        probe: null,
      }),
      export: async () => 0,
      clear: async () => {},
      health: async () => ({
        exists: false,
        writable: true,
        corruptLines: 0,
        samples: 0,
        detail: 'local sink not created yet',
      }),
    },
    confirmation: { confirmDangerousNoSandbox: async () => false },
    session: {
      start: async () => ({ id: 'unconnected-session' }),
      resume: async (id) => ({ id }),
      interrupt: async () => {},
      end: async () => {},
    },
  }
}
