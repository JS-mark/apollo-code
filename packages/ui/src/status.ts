import type { WelcomePanelData } from './welcome'

export type StatusTabId = 'settings' | 'status' | 'config'
export type StatusValue = boolean | number | string
export type StatusConfigKind = 'boolean' | 'enum' | 'number' | 'string'

export interface StatusConfigItem {
  id: string
  label: string
  value: StatusValue
  editable: boolean
  kind?: StatusConfigKind
  choices?: readonly string[]
  min?: number
  max?: number
  readonlyReason?: string
}

export interface StatusPanelData {
  settings: readonly { label: string; value: string }[]
  status: readonly { label: string; value: string }[]
  config: readonly StatusConfigItem[]
}

export interface StatusPanelController {
  update(id: string, value: StatusValue): Promise<StatusPanelData>
}

export interface StatusReason {
  code: string
}

export type StatusAvailability<T> =
  | { status: 'available'; value: T }
  | { status: 'disabled'; reason?: StatusReason }
  | { status: 'blocked'; reason: StatusReason }
  | { status: 'not_available'; reason: StatusReason }

export type StatusSource = 'default' | 'user' | 'project' | 'env' | 'flag' | 'session'
export type StatusModelSource = StatusSource | 'router' | 'derived_unreliable'

export interface StatusViewModel {
  identity: {
    version: string
    sessionId: string
    createdAt: string
    cwd: string
    workspace: StatusAvailability<string>
    project: StatusAvailability<string>
  }
  model:
    | {
        status: 'available'
        provider: string
        model: string
        liteModel: StatusAvailability<string>
        reasoningModel: StatusAvailability<string>
        source: Exclude<StatusModelSource, 'derived_unreliable'>
      }
    | {
        status: 'not_available'
        reason: StatusReason
        source: StatusModelSource
      }
  runtime: {
    sandbox: StatusAvailability<{ tier: 'full' | 'none' | 'partial' | 'weak'; mechanism: string }>
    filesystem: StatusAvailability<'isolated' | 'unrestricted' | 'workspace'>
    network: StatusAvailability<'available' | 'restricted' | 'unavailable'>
    permission: StatusAvailability<{
      mode: 'allow-session' | 'ask' | 'bypassed' | 'read-only' | 'yolo'
      source: StatusSource
    }>
    memory: StatusAvailability<{ mode: string }>
  }
  auth: {
    configured: StatusAvailability<boolean>
    method: StatusAvailability<'keychain' | 'encrypted_file' | 'env'>
  }
  settings: readonly StatusSetting[]
  config: {
    sources: StatusAvailability<readonly StatusSource[]>
  }
  capabilities: {
    mcpServers: StatusAvailability<StatusCapabilitySummary>
    skills: StatusAvailability<StatusCapabilitySummary>
    plugins: StatusAvailability<StatusCapabilitySummary>
  }
  usage: {
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
    context: { currentTokens: number; maxTokens: number; lastCompactedAt?: string }
    costUSD: number
  }
}

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

export function statusPanelFromWelcome(data: WelcomePanelData): StatusPanelData {
  const unavailable = 'not available'
  const model =
    data.model.status === 'available' ? `${data.model.provider}/${data.model.model}` : unavailable
  const sources = data.config.effectiveSources.length
    ? data.config.effectiveSources.join(', ')
    : 'defaults'
  return {
    settings: [
      { label: 'Language', value: 'system default' },
      { label: 'Model', value: model },
      { label: 'Settings sources', value: sources },
      { label: 'Memory', value: unavailable },
    ],
    status: [
      { label: 'Version', value: data.version },
      { label: 'Session ID', value: data.sessionId },
      { label: 'cwd', value: data.cwd },
      { label: 'Auth method', value: data.authMethod ?? unavailable },
      { label: 'Model', value: model },
      { label: 'Lite model', value: data.liteModel ?? unavailable },
      { label: 'Reasoning model', value: data.reasoningModel ?? unavailable },
      { label: 'Memory', value: data.memoryMode ?? unavailable },
      { label: 'Settings sources', value: sources },
      { label: 'Workspace', value: data.workspace ?? data.cwd },
      { label: 'MCP servers', value: summarizeMcp(data) },
      { label: 'Skills', value: data.skillsSummary ?? unavailable },
      { label: 'Plugins', value: data.pluginsSummary ?? unavailable },
      {
        label: 'Sandbox',
        value:
          data.sandbox.status === 'available'
            ? `${data.sandbox.tier} (${data.sandbox.mechanism})`
            : data.sandbox.status === 'probing'
              ? 'probing'
              : unavailable,
      },
      {
        label: 'Network',
        value: data.sandbox.status === 'available' ? data.sandbox.network : unavailable,
      },
      {
        label: 'Filesystem',
        value: data.sandbox.status === 'available' ? data.sandbox.filesystem : unavailable,
      },
      { label: 'Permissions', value: data.permission.mode },
    ],
    config: data.statusConfig ?? defaultStatusConfig(model),
  }
}

export const EDITABLE_STATUS_CONFIG_IDS = new Set([
  'language',
  'model',
  'reasoningEffort',
  'autoCompact',
  'notifications',
  'promptSuggestions',
  'showTokensCounter',
  'terminalProgressBar',
  'autoMemory',
  'typedMemory',
  'outputStyle',
  'cleanupPeriod',
])

export function validateStatusConfigValue(configItem: StatusConfigItem, value: StatusValue) {
  if (!configItem.editable || !EDITABLE_STATUS_CONFIG_IDS.has(configItem.id))
    throw new Error(`${configItem.label} is read-only`)
  if (configItem.kind === 'boolean' && typeof value !== 'boolean')
    throw new Error('Expected a boolean')
  if ((configItem.kind === 'enum' || configItem.kind === 'string') && typeof value !== 'string')
    throw new Error('Expected text')
  if (configItem.kind === 'enum' && !configItem.choices?.includes(String(value)))
    throw new Error(`Allowed values: ${configItem.choices?.join(', ')}`)
  if (configItem.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new Error('Expected an integer')
    if (configItem.min !== undefined && value < configItem.min)
      throw new Error(`Minimum is ${configItem.min}`)
    if (configItem.max !== undefined && value > configItem.max)
      throw new Error(`Maximum is ${configItem.max}`)
  }
}

export function buildStatusSections(view: StatusViewModel): StatusSection[] {
  const model =
    view.model.status === 'available'
      ? `${view.model.provider}/${view.model.model}`
      : formatStatusAvailability(view.model)
  const statusItems: StatusSectionItem[] = [
    item('identity.version', 'Version', view.identity.version),
    item('identity.sessionId', 'Session ID', view.identity.sessionId),
    item('identity.createdAt', 'Created', view.identity.createdAt),
    item('identity.cwd', 'CWD', view.identity.cwd),
    item('identity.workspace', 'Workspace', formatStatusAvailability(view.identity.workspace)),
    item('identity.project', 'Project', formatStatusAvailability(view.identity.project)),
    item('model.current', 'Model', model),
    item('auth.configured', 'Auth configured', formatStatusAvailability(view.auth.configured)),
    item('auth.method', 'Auth method', formatStatusAvailability(view.auth.method)),
    item('runtime.sandbox', 'Sandbox', formatStatusAvailability(view.runtime.sandbox)),
    item('runtime.filesystem', 'Filesystem', formatStatusAvailability(view.runtime.filesystem)),
    item('runtime.network', 'Network', formatStatusAvailability(view.runtime.network)),
    item('runtime.permission', 'Permission', formatStatusAvailability(view.runtime.permission)),
    item('runtime.memory', 'Memory', formatStatusAvailability(view.runtime.memory)),
    item('capabilities.mcp', 'MCP servers', formatStatusAvailability(view.capabilities.mcpServers)),
    item('capabilities.skills', 'Skills', formatStatusAvailability(view.capabilities.skills)),
    item('capabilities.plugins', 'Plugins', formatStatusAvailability(view.capabilities.plugins)),
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
        value: formatStatusAvailability(view.config.sources),
        ...(view.config.sources.status !== 'available' && view.config.sources.reason
          ? { reasonCode: view.config.sources.reason.code }
          : {}),
      },
    ],
  }
  return [status, settings, config]
}

const secretKey = /(authorization|api[_-]?key|token|secret|credential|passphrase|password|oauth)/i

function defaultStatusConfig(model: string): StatusConfigItem[] {
  return [
    { id: 'language', label: 'Language', value: 'system', editable: true, kind: 'string' },
    { id: 'model', label: 'Model', value: model, editable: true, kind: 'string' },
    {
      id: 'reasoningEffort',
      label: 'Reasoning Effort',
      value: 'medium',
      editable: true,
      kind: 'enum',
      choices: ['low', 'medium', 'high'],
    },
    ...[
      'autoCompact',
      'notifications',
      'promptSuggestions',
      'showTokensCounter',
      'terminalProgressBar',
      'autoMemory',
      'typedMemory',
    ].map((id) => ({
      id,
      label: splitLabel(id),
      value: false,
      editable: true,
      kind: 'boolean' as const,
    })),
    {
      id: 'outputStyle',
      label: 'Output Style',
      value: 'default',
      editable: true,
      kind: 'enum',
      choices: ['default', 'concise', 'explanatory'],
    },
    {
      id: 'cleanupPeriod',
      label: 'Cleanup Period',
      value: 30,
      editable: true,
      kind: 'number',
      min: 1,
      max: 365,
    },
    ...[
      'authMethod',
      'sessionId',
      'enterprisePolicies',
      'trustAllDirectory',
      'mcpPermissions',
      'filesystemPermissions',
      'externalAccounts',
    ].map((id) => ({
      id,
      label: splitLabel(id),
      value: 'read-only',
      editable: false,
      readonlyReason: 'Security state cannot be changed here',
    })),
  ]
}

function splitLabel(value: string) {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (character) => character.toUpperCase())
}

function summarizeMcp(data: WelcomePanelData) {
  return data.mcp.status === 'available'
    ? `${data.mcp.connected} connected / ${data.mcp.total} configured`
    : 'not available'
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

function formatStatusAvailability(
  value: StatusAvailability<unknown> | StatusViewModel['model'],
): string {
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
