import type { ContentPart } from '@apollo-code/provider-kit'
import type { JsonValue, Logger } from '@apollo-code/shared'

export interface PermissionSpec { kind: 'fs-read' | 'fs-write' | 'network' | 'process'; resources: string[] }
export interface SessionSnapshot { id: string; cwd: string; turnId: string }
export interface NativeBridge { execute(command: string, args: string[], signal: AbortSignal): Promise<unknown> }
export interface ToolUiPort { requestInput(prompt: string): Promise<string> }
export interface ToolContext { readonly abortSignal: AbortSignal; readonly session: SessionSnapshot; readonly native: NativeBridge; readonly logger: Logger; readonly ui: ToolUiPort }
export interface ToolResultMeta { durationMs: number; bytesRead?: number; bytesWritten?: number; filesTouched?: string[]; costImpact?: 'safe' | 'moderate' | 'high' }
export interface ToolResult { content: ContentPart[]; isError?: boolean; meta?: ToolResultMeta }
export interface Tool<Input = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, JsonValue>
  readonly outputHint?: string
  readonly readonly?: boolean
  readonly timeoutMs?: number
  readonly parallelSafe?: boolean
  permissionSpec(input: Input): PermissionSpec
  invoke(input: Input, context: ToolContext): Promise<ToolResult>
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>()
  register(tool: Tool): () => void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.#tools.set(tool.name, tool)
    return () => this.#tools.delete(tool.name)
  }
  get(name: string): Tool | undefined { return this.#tools.get(name) }
  list(): readonly Tool[] { return [...this.#tools.values()] }
}
