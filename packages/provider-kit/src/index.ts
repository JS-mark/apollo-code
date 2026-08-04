import type { ApolloErrorCategory, JsonValue } from '@apollo-code/shared'

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  costUSD?: number
}
export type ProviderErrorCategory = ApolloErrorCategory
export interface ProviderError extends Error {
  provider: string
  model?: string
  status?: number
  category: ProviderErrorCategory
  retryable: boolean
  retryAfterMs?: number
  cause?: unknown
}
export type AttachmentRef =
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'path'; absPath: string }
  | { kind: 'handle'; handle: string }
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'image'; source: AttachmentRef; mime: string }
  | { type: 'file'; source: AttachmentRef; mime: string; filename: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue }
  | { type: 'tool_result'; toolUseId: string; content: ContentPart[]; isError?: boolean }

export interface Message {
  id: string
  role: 'assistant' | 'system' | 'user'
  content: ContentPart[]
  createdAt: number
  meta?: {
    provider?: string
    model?: string
    usage?: Usage
    stopReason?: StopReason
    compacted?: boolean
    compactedMessageIds?: string[]
    turnId?: string
    pinnedToContext?: boolean
  }
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
}
export interface ProviderCapabilities {
  maxContextTokens: number
  maxOutputTokens: number
  toolUse: 'none' | 'sequential' | 'parallel'
  toolResultSchema: 'anthropic' | 'openai' | 'gemini' | 'json-string'
  vision: false | { formats: string[]; maxSizeMB: number }
  files: false | { formats: string[]; maxSizeMB: number }
  thinking: false | { budgetTokens: boolean }
  streaming: boolean
  streamingReasoning: boolean
  cache: 'none' | 'ephemeral' | 'persistent'
  jsonMode: boolean
  structuredOutput: boolean
  systemPromptLocation: 'system-field' | 'first-user-message'
  toolChoiceRequired: boolean
  interleavedThinking: boolean
}
export interface ProviderRequest {
  model: string
  messages: readonly Message[]
  system?: string
  tools?: ToolSchema[]
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  responseFormat?: 'text' | 'json'
  reasoning?: { enabled: boolean; budgetTokens?: number }
  cache?: { strategy: 'ephemeral' | 'persistent' | 'off'; ttlSeconds?: number }
  rawMeta?: RawMeta
}
export interface RawMeta {
  anthropic?: {
    cacheControl?: { type: 'ephemeral' }[]
    metadata?: { user_id?: string }
    computerUse?: { displayWidth: number; displayHeight: number }
  }
  openai?: {
    logprobs?: boolean
    seed?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
    modalities?: ('text' | 'audio')[]
  }
  gemini?: {
    safetySettings?: Array<{ category: string; threshold: string }>
    candidateCount?: number
  }
  ollama?: { keepAlive?: string; numCtx?: number }
}
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'
export type ProviderChunk =
  | { kind: 'message.start'; messageId: string }
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string; signature?: string }
  | { kind: 'tool_use.start'; id: string; name: string }
  | { kind: 'tool_use.delta'; id: string; argsFragment: string }
  | { kind: 'tool_use.end'; id: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'message.stop'; stopReason: StopReason }
  | {
      kind: 'message.interrupted'
      reason: string
      partial?: { text?: string; toolUseIds?: string[] }
    }
  | { kind: 'error'; error: ProviderError }
export interface ProviderResponse {
  message: Message
  usage: Usage
}
export interface ProviderClient {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>
  complete?(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>
  countTokens?(messages: Message[], tools?: ToolSchema[]): Promise<number>
  dispose(): Promise<void>
}

export interface ContextConfig {
  compactionThreshold?: number
  targetRatio?: number
  reservedOutputTokens?: number
  keepRecent?: number
  maxTokens?: number
}
export interface ContextSessionSnapshot {
  messages: readonly Message[]
  activeTurn?: string | null
  turns?: readonly { id: string; status: string; startMessageId?: string; endMessageId?: string }[]
}
export interface ContextCtx {
  readonly session: ContextSessionSnapshot
  readonly capabilities: ProviderCapabilities
  readonly turnId: string
  readonly model: string
  readonly systemTokens?: number
  readonly toolSchemaTokens?: number
}
export interface ContextMessages {
  messages: readonly Message[]
  removedMessageIds: string[]
  estimatedTokens: number
  hasSummary: boolean
}
export interface ContextSnapshot {
  messages: readonly Message[]
  compactedMessageIds: string[]
  beforeTokens: number
  afterTokens: number
  strategy: string
  hookIntercepted: boolean
}
export interface ContextPolicy {
  readonly name: string
  shouldCompact(context: ContextCtx): boolean
  buildPrompt(context: ContextCtx): ContextMessages
  compact(context: ContextCtx): Promise<ContextSnapshot>
  estimateTokens(text: string, model: string): number
  init?(config: ContextConfig): Promise<void>
  dispose?(): Promise<void>
}
export interface ContextPolicySpec {
  readonly name: string
  readonly policy: ContextPolicy
  readonly priority: number
  readonly when?: (context: ContextCtx) => boolean
}
export interface ContextPolicyRegistration {
  dispose(): void
}
export interface ContextPolicyContributor {
  contributePolicy(spec: ContextPolicySpec): ContextPolicyRegistration
}
