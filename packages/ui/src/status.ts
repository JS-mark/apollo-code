export interface StatusReason {
  code: string
}

export type StatusValue<T> =
  | { status: 'available'; value: T }
  | { status: 'disabled'; reason?: StatusReason }
  | { status: 'blocked'; reason: StatusReason }
  | { status: 'not_available'; reason: StatusReason }

export type StatusSource = 'default' | 'user' | 'project' | 'env' | 'flag' | 'session'

export interface StatusViewModel {
  identity: {
    version: string
    sessionId: string
    createdAt: string
    cwd: string
    workspace: StatusValue<string>
    project: StatusValue<string>
  }
  model:
    | {
        status: 'available'
        provider: string
        model: string
        liteModel: StatusValue<string>
        reasoningModel: StatusValue<string>
        source: Exclude<StatusModelSource, 'derived_unreliable'>
      }
    | {
        status: 'not_available'
        reason: StatusReason
        source: StatusModelSource
      }
  runtime: {
    sandbox: StatusValue<{ tier: 'full' | 'none' | 'partial' | 'weak'; mechanism: string }>
    filesystem: StatusValue<'isolated' | 'unrestricted' | 'workspace'>
    network: StatusValue<'available' | 'restricted' | 'unavailable'>
    permission: StatusValue<{
      mode: 'allow-session' | 'ask' | 'bypassed' | 'read-only' | 'yolo'
      source: StatusSource
    }>
    memory: StatusValue<{ mode: string }>
  }
  auth: {
    configured: boolean | null
    method: StatusValue<'keychain' | 'encrypted_file' | 'env'>
  }
  settings: readonly StatusSetting[]
  config: {
    sources: StatusValue<readonly StatusSource[]>
  }
  capabilities: {
    mcpServers: StatusValue<StatusCapabilitySummary>
    skills: StatusValue<StatusCapabilitySummary>
    plugins: StatusValue<StatusCapabilitySummary>
  }
  usage: {
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
    context: { currentTokens: number; maxTokens: number; lastCompactedAt?: string }
    costUSD: number
  }
}

export type StatusModelSource = StatusSource | 'router' | 'derived_unreliable'

export interface StatusSetting {
  key: string
  effectiveValue: boolean | number | string
  source: StatusSource | 'not_available'
  readonly: boolean
  locked: boolean
  reason?: StatusReason
}

export interface StatusCapabilitySummary {
  count: number
  names?: readonly string[]
}

export interface StatusSection {
  id: 'config' | 'settings' | 'status'
  title: string
  items: readonly StatusSectionItem[]
}

export interface StatusSectionItem {
  key: string
  label: string
  value: boolean | number | string
  source?: string
  readonly?: boolean
  locked?: boolean
  reasonCode?: string
}

const secretKey = /(authorization|api[_-]?key|token|secret|credential|passphrase|password|oauth)/i

export function buildStatusSections(view: StatusViewModel): StatusSection[] {
  const model =
    view.model.status === 'available'
      ? `${view.model.provider}/${view.model.model}`
      : statusValue(view.model)
  const statusItems: StatusSectionItem[] = [
    item('identity.version', 'Version', view.identity.version),
    item('identity.sessionId', 'Session ID', view.identity.sessionId),
    item('identity.createdAt', 'Created', view.identity.createdAt),
    item('identity.cwd', 'CWD', view.identity.cwd),
    item('identity.workspace', 'Workspace', statusValue(view.identity.workspace)),
    item('identity.project', 'Project', statusValue(view.identity.project)),
    item('model.current', 'Model', model),
    item('auth.configured', 'Auth configured', view.auth.configured ?? 'not available'),
    item('auth.method', 'Auth method', statusValue(view.auth.method)),
    item('runtime.sandbox', 'Sandbox', statusValue(view.runtime.sandbox)),
    item('runtime.filesystem', 'Filesystem', statusValue(view.runtime.filesystem)),
    item('runtime.network', 'Network', statusValue(view.runtime.network)),
    item('runtime.permission', 'Permission', statusValue(view.runtime.permission)),
    item('runtime.memory', 'Memory', statusValue(view.runtime.memory)),
    item('capabilities.mcp', 'MCP servers', statusValue(view.capabilities.mcpServers)),
    item('capabilities.skills', 'Skills', statusValue(view.capabilities.skills)),
    item('capabilities.plugins', 'Plugins', statusValue(view.capabilities.plugins)),
    item(
      'usage.tokens',
      'Tokens',
      `${view.usage.tokens.input} input / ${view.usage.tokens.output} output`,
    ),
    item(
      'usage.context',
      'Context',
      `${view.usage.context.currentTokens} / ${view.usage.context.maxTokens}`,
    ),
    item('usage.costUSD', 'Cost USD', view.usage.costUSD),
  ]
  if (view.model.status === 'not_available') {
    const index = statusItems.findIndex((entry) => entry.key === 'model.current')
    statusItems[index] = { ...statusItems[index]!, reasonCode: view.model.reason.code }
  }
  const status: StatusSection = {
    id: 'status',
    title: 'Status',
    items: statusItems,
  }

  const settings: StatusSection = {
    id: 'settings',
    title: 'Settings',
    items: view.settings
      .filter((setting) => !secretKey.test(setting.key))
      .map((setting) => settingItem(setting)),
  }
  const config: StatusSection = {
    id: 'config',
    title: 'Config',
    items: [
      {
        key: 'config.sources',
        label: 'Effective sources',
        value: statusValue(view.config.sources),
        ...(view.config.sources.status !== 'available' && view.config.sources.reason
          ? { reasonCode: view.config.sources.reason.code }
          : {}),
      },
    ],
  }
  return [status, settings, config]
}

function item(key: string, label: string, value: boolean | number | string): StatusSectionItem {
  return { key, label, value }
}

function settingItem(setting: StatusSetting): StatusSectionItem {
  return {
    key: setting.key,
    label: setting.key,
    value: setting.effectiveValue,
    source: setting.source,
    readonly: setting.readonly,
    locked: setting.locked,
    ...(setting.reason ? { reasonCode: setting.reason.code } : {}),
  }
}

function statusValue(value: StatusValue<unknown> | StatusViewModel['model']): string {
  if (value.status !== 'available') return `${value.status}:${value.reason?.code ?? 'disabled'}`
  if (!('value' in value)) return 'available'
  if (Array.isArray(value.value)) return value.value.join(', ')
  if (value.value && typeof value.value === 'object') {
    if ('count' in value.value && typeof value.value.count === 'number') {
      const names =
        'names' in value.value && Array.isArray(value.value.names) ? value.value.names : []
      return names.length
        ? `${value.value.count}: ${names.map(String).join(', ')}`
        : String(value.value.count)
    }
    return Object.entries(value.value)
      .map(([key, entry]) => `${key}=${String(entry)}`)
      .join(', ')
  }
  return String(value.value)
}
