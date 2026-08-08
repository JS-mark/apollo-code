export interface UnavailableReason {
  code: string
  message: string
}

export interface WelcomePanelData {
  config: WelcomeConfigStatus
  cwd: string
  history: WelcomeHistoryStatus
  mcp: WelcomeMcpStatus
  model: WelcomeModelStatus
  permission: WelcomePermissionStatus
  sandbox: WelcomeSandboxStatus
  sessionId: string
  trustLabel?: string
  version: string
}

export type WelcomeModelStatus =
  | {
      status: 'available'
      provider: string
      model: string
      source: 'config' | 'default' | 'explicit' | 'session'
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }
  | {
      status: 'unknown'
      reason?: UnavailableReason
    }

export type WelcomeSandboxStatus =
  | {
      status: 'available'
      tier: 'full' | 'none' | 'partial' | 'weak'
      mechanism: string
      filesystem: 'isolated' | 'unknown' | 'unrestricted' | 'workspace'
      network: 'available' | 'restricted' | 'unavailable' | 'unknown'
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export interface WelcomePermissionStatus {
  dangerous: boolean
  mode: 'allow-session' | 'ask' | 'bypassed' | 'read-only' | 'yolo'
  source: 'config' | 'default' | 'flag' | 'session'
}

export interface WelcomeConfigStatus {
  effectiveSources: readonly ConfigSourceKind[]
  project: ConfigSourceStatus
  user: ConfigSourceStatus
}

export type ConfigSourceKind = 'defaults' | 'project' | 'user'

export type ConfigSourceStatus =
  | {
      status: 'available'
      path: string
      trusted: true
    }
  | {
      status: 'blocked'
      path: string
      trusted: false
      reason: UnavailableReason
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export type WelcomeMcpStatus =
  | {
      status: 'available'
      connected: number
      servers: readonly WelcomeMcpServerSummary[]
      total: number
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }

export interface WelcomeMcpServerSummary {
  name: string
  status: 'connected' | 'disabled' | 'failed'
}

export type WelcomeHistoryStatus =
  | {
      status: 'available'
      entries: number
      maxEntries: number
      path: string
    }
  | {
      status: 'disabled'
      reason?: UnavailableReason
    }
  | {
      status: 'unavailable'
      reason: UnavailableReason
    }
