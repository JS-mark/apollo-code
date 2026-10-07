import type { TranscriptEntry } from '@volund/app-runtime'

import { formatPermissionTextForDisplay } from './permission-display'

/**
 * 工具活动行（◆ 正在读取 …）的数据模型与纯函数。
 *
 * 数据流：runner 的 `tool.requested`（附录 D.2，★input 携带工具参数）创建条目，
 * `tool.completed` 按 toolUseId 定稿（成功/失败 + 耗时 + 行级变更）。条目随事件
 * 进时间线，与 transcript 消息按事件 id（uuidv7 ≈ 时间序）归并渲染——对话流里
 * 的「助手消息 → 工具活动 → 下一条助手消息」顺序由此而来。
 */
export interface ActivityItem {
  /** tool.requested 的事件 id（uuidv7，字典序≈时间序）。 */
  id: string
  toolUseId: string
  tool: string
  /** 从 input 提取的展示目标（路径/命令/模式…），已清洗截断；无目标时省略。 */
  target?: string
  status: 'running' | 'done' | 'error'
  /** 被 PreToolUse hook 拦截（tool.completed ?blocked）：渲染「已被拦截」。 */
  blocked?: boolean
  durationMs?: number
  linesAdded?: number
  linesRemoved?: number
}

/** 时间线条目：transcript 消息与工具活动的并集（ScrollableTranscript 的输入）。 */
export type TimelineItem =
  | { entry: TranscriptEntry; kind: 'message' }
  | { item: ActivityItem; kind: 'activity' }

interface ActivityVerbs {
  running: string
  done: string
  error: string
}

const TOOL_VERBS: Record<string, ActivityVerbs> = {
  Read: { running: 'Reading', done: 'Read', error: 'Read failed' },
  Write: { running: 'Writing', done: 'Wrote', error: 'Write failed' },
  Edit: { running: 'Editing', done: 'Edited', error: 'Edit failed' },
  MultiEdit: { running: 'Editing', done: 'Edited', error: 'Edit failed' },
  Bash: { running: 'Running', done: 'Ran', error: 'Run failed' },
  Glob: { running: 'Finding files', done: 'Found files', error: 'Find failed' },
  Grep: { running: 'Searching', done: 'Search done', error: 'Search failed' },
  WebFetch: { running: 'Fetching page', done: 'Fetched page', error: 'Fetch failed' },
  WebSearch: { running: 'Searching the web', done: 'Search done', error: 'Search failed' },
  Task: { running: 'Running subagent', done: 'Subagent done', error: 'Subagent failed' },
  Todo: { running: 'Updating todos', done: 'Todos updated', error: 'Todo update failed' },
  ShellOutput: { running: 'Reading output', done: 'Read output', error: 'Read failed' },
  KillShell: { running: 'Stopping process', done: 'Stopped process', error: 'Stop failed' },
}

/**
 * mcp__〈server〉__〈tool〉 拆解（SKILLS-MCPS-r1 §S3.5 双下划线命名，与
 * packages/mcp-client 的 mcpToolName 同规则）；非 MCP 工具回 undefined。
 */
export function mcpToolParts(tool: string): { server: string; name: string } | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return undefined
  return { server: rest.slice(0, sep), name: rest.slice(sep + 2) }
}

/** MCP 工具的展示名：`server/name`（如 github/search）；非 MCP 回 undefined。 */
export function mcpToolDisplayName(tool: string): string | undefined {
  const parts = mcpToolParts(tool)
  return parts ? `${parts.server}/${parts.name}` : undefined
}

export function activityVerbs(tool: string): ActivityVerbs {
  const mcp = mcpToolDisplayName(tool)
  if (mcp)
    return {
      running: `Calling MCP ${mcp}`,
      done: `MCP ${mcp} done`,
      error: `MCP ${mcp} failed`,
    }
  return (
    TOOL_VERBS[tool] ?? { running: `Using ${tool}`, done: `${tool} done`, error: `${tool} failed` }
  )
}

/** 各工具最具辨识度的参数名（Grep/Glob 取 pattern 而非可选的 path 搜索根）。 */
const TARGET_KEY_BY_TOOL: Record<string, string> = {
  Read: 'path',
  Write: 'path',
  Edit: 'path',
  MultiEdit: 'path',
  Bash: 'command',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  ShellOutput: 'shellId',
  KillShell: 'shellId',
  Task: 'agentType',
}

/** 未知工具的兜底候选键（按辨识度排序；绝不取 content/old_string 等正文参数）。 */
const FALLBACK_TARGET_KEYS = ['path', 'file_path', 'command', 'pattern', 'url', 'query'] as const

const MAX_TARGET_LENGTH = 72
/** permission-display 对换行的注入安全转义 token（详见 NEWLINE_TOKEN 使用处）。 */
const NEWLINE_TOKEN = '\\u{000A}'

/**
 * 从 tool.requested 的 input 提取单行展示目标。input 是模型产出的不可信文本：
 * 先过 SafeDisplay 转义（bidi/控制字符），再把换行 token 压成空格，最后截断。
 */
export function activityTarget(tool: string, input: unknown): string | undefined {
  // MCP 工具的入参无统一 target 语义（fallback 键多为猜测），server/name 已在动词里。
  if (mcpToolParts(tool)) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const preferred = TARGET_KEY_BY_TOOL[tool]
  const raw =
    (preferred ? stringValue(record[preferred]) : undefined) ??
    FALLBACK_TARGET_KEYS.map((key) => stringValue(record[key])).find((value) => value !== undefined)
  if (!raw) return undefined
  const escaped = formatPermissionTextForDisplay(raw).text
  const oneLine = escaped.split(NEWLINE_TOKEN).join(' ').replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  const prefixed = tool === 'Bash' ? `$ ${oneLine}` : oneLine
  return prefixed.length > MAX_TARGET_LENGTH
    ? `${prefixed.slice(0, MAX_TARGET_LENGTH - 1)}…`
    : prefixed
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** tool.completed 载荷里与活动行相关的字段（附录 D.2）。 */
export interface ActivityCompletion {
  isError: boolean
  blocked?: boolean
  durationMs?: number
  linesAdded?: number
  linesRemoved?: number
}

/** 按 toolUseId 定稿活动条目；未找到（如回放缺 requested）时原样返回。 */
export function completeActivity(
  activities: readonly ActivityItem[],
  toolUseId: string,
  completion: ActivityCompletion,
): ActivityItem[] {
  if (!activities.some((item) => item.toolUseId === toolUseId)) return [...activities]
  return activities.map((item) => {
    if (item.toolUseId !== toolUseId) return item
    return {
      ...item,
      status: completion.isError ? ('error' as const) : ('done' as const),
      ...(completion.blocked !== undefined ? { blocked: completion.blocked } : {}),
      ...(completion.durationMs !== undefined ? { durationMs: completion.durationMs } : {}),
      ...(completion.linesAdded !== undefined ? { linesAdded: completion.linesAdded } : {}),
      ...(completion.linesRemoved !== undefined ? { linesRemoved: completion.linesRemoved } : {}),
    }
  })
}

/** 紧凑耗时：0.3s / 4s / 2m05s。 */
export function formatActivityDuration(durationMs: number): string {
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`
  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

/**
 * transcript 消息与工具活动按事件 id 归并成一条时间线。notice-*（启动期系统
 * 提示）永远在最前；pending-assistant（流式暂存）永远在最后——工具活动只发生在
 * 一个 assistant step 定稿之后，时间上必然早于下一步的流式文本。
 */
export function buildTimeline(
  transcript: readonly TranscriptEntry[],
  activities: readonly ActivityItem[],
): TimelineItem[] {
  const tagged: Array<{ order: number; sortId: string; value: TimelineItem }> = [
    ...transcript.map((entry, index) => ({
      order: index,
      sortId: entry.id,
      value: { entry, kind: 'message' as const },
    })),
    ...activities.map((item, index) => ({
      order: transcript.length + index,
      sortId: item.id,
      value: { item, kind: 'activity' as const },
    })),
  ]
  tagged.sort((a, b) => compareTimelineIds(a.sortId, b.sortId) || a.order - b.order)
  return tagged.map((tag) => tag.value)
}

function compareTimelineIds(a: string, b: string): number {
  const rankA = timelineRank(a)
  const rankB = timelineRank(b)
  if (rankA !== rankB) return rankA - rankB
  if (a === b) return 0
  return a < b ? -1 : 1
}

function timelineRank(id: string): number {
  if (id.startsWith('notice-')) return 0
  if (id === 'pending-assistant') return 2
  return 1
}
