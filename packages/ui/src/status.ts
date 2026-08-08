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

export function validateStatusConfigValue(item: StatusConfigItem, value: StatusValue) {
  if (!item.editable || !EDITABLE_STATUS_CONFIG_IDS.has(item.id))
    throw new Error(`${item.label} is read-only`)
  if (item.kind === 'boolean' && typeof value !== 'boolean') throw new Error('Expected a boolean')
  if ((item.kind === 'enum' || item.kind === 'string') && typeof value !== 'string')
    throw new Error('Expected text')
  if (item.kind === 'enum' && !item.choices?.includes(String(value)))
    throw new Error(`Allowed values: ${item.choices?.join(', ')}`)
  if (item.kind === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new Error('Expected an integer')
    if (item.min !== undefined && value < item.min) throw new Error(`Minimum is ${item.min}`)
    if (item.max !== undefined && value > item.max) throw new Error(`Maximum is ${item.max}`)
  }
}

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
