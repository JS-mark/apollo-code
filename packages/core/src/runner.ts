import type {
  ContentPart,
  ContextPolicy,
  Message,
  ProviderChunk,
  ProviderClient,
  ProviderError,
  StopReason,
  ToolSchema,
  Usage,
} from '@apollo-code/provider-kit'
import type { RouterDecision, RouterHint, RouterPolicy } from '@apollo-code/router'
import type { JsonValue } from '@apollo-code/shared'
import { v7 as uuidv7 } from 'uuid'

import { EventBus } from './event-bus'
import type { PromptComposer } from './prompt-composer'
import { updateSession, type SessionState } from './session'

export interface ToolExecution {
  toolUseId: string
  toolName?: string
  content: ContentPart[]
  isError?: boolean
}
export interface RunnerToolPort {
  schemas(provider: ProviderClient): ToolSchema[]
  execute(
    toolUse: Extract<ContentPart, { type: 'tool_use' }>,
    signal: AbortSignal,
  ): Promise<ToolExecution>
}
export interface RunnerOptions {
  maxToolLoopsPerTurn?: number
  budget?: { tokenMax?: number; costUSDMax?: number; timeMsMax?: number; toolCallMax?: number }
}
/**
 * tool_use 流式聚合条目（spec 03-provider-router §3.2 rule 1）：
 * `fragments` 即 `Map<toolUseId, string[]>` 的 per-id 片段列表，delta 按 id 追加，
 * `tool_use.end` 时 join 全文并做一次性 `JSON.parse`。
 */
interface AggregatingToolUse {
  id: string
  name: string
  fragments: string[]
  raw?: string // join 结果，end 时定稿
  input?: JsonValue // parse 成功时定稿；undefined = 未 parse 或 parse 失败
  ended?: boolean
}
interface InProgress {
  text: string
  thinking: string
  tools: Map<string, AggregatingToolUse>
  invalidTools: Set<string> // parse 失败的 toolUseId（§3.2 rule 2：不执行）
  usage?: Usage
  stopReason?: StopReason
}

export class Runner {
  #state: SessionState
  #turnAbort?: AbortController
  constructor(
    state: SessionState,
    readonly router: RouterPolicy,
    readonly promptComposer: PromptComposer,
    readonly tools: RunnerToolPort,
    readonly events = new EventBus(),
    readonly options: RunnerOptions = {},
    readonly contextPolicy?: ContextPolicy,
  ) {
    this.#state = state
  }
  get state(): SessionState {
    return this.#state
  }
  interrupt(): void {
    this.#state = updateSession(this.#state, (draft) => {
      draft.pendingInterrupt = true
    })
    this.#turnAbort?.abort()
  }
  async run(input: string | readonly ContentPart[], hint?: RouterHint): Promise<SessionState> {
    const turnId = uuidv7()
    this.#turnAbort = new AbortController()
    const signal = this.#turnAbort.signal
    this.#state = updateSession(this.#state, (draft) => {
      draft.pendingInterrupt = false
      draft.activeTurn = turnId
      draft.turns = [
        ...draft.turns,
        {
          id: turnId,
          startMessageId: '',
          status: 'streaming',
          parentDepth: this.#state.lineage?.depth ?? 0,
          ...(this.#state.lineage?.parentTurnId
            ? { parentTurnId: this.#state.lineage.parentTurnId }
            : {}),
          ...(this.#state.lineage?.agentType ? { agentType: this.#state.lineage.agentType } : {}),
        },
      ]
    })
    await this.emit('turn.started', turnId, {})
    const user = this.message(
      'user',
      typeof input === 'string' ? [{ type: 'text', text: input }] : [...input],
    )
    this.append(user)
    await this.emit('message.appended', turnId, { messageId: user.id })
    let sticky: ProviderClient | undefined
    let decision: RouterDecision | undefined
    let retryDecision: RouterDecision | undefined
    let attempts = 0
    let loops = 0
    let toolCalls = 0
    let failed = false
    const turnStartedAt = Date.now()
    const agentType = this.#state.lineage?.agentType
    const lineageRole: RouterHint['role'] =
      agentType === 'planner' || agentType === 'coder' || agentType === 'reviewer'
        ? agentType
        : undefined
    const routerHint = lineageRole ? { role: lineageRole, ...hint } : hint
    try {
      outer: while (!signal.aborted) {
        const exhausted = this.exhaustedBudget(turnStartedAt, toolCalls)
        if (exhausted) {
          await this.emit('error.raised', turnId, {
            code: 'subagent_budget_exhausted',
            dimension: exhausted,
            consumed: {
              input: this.#state.cumulativeUsage.input,
              output: this.#state.cumulativeUsage.output,
              costUSD: this.#state.cumulativeUsage.costUSD,
              timeMs: Date.now() - turnStartedAt,
              toolCalls,
            },
            budget: this.options.budget ?? this.#state.resourceBudget ?? {},
          })
          this.#turnAbort.abort('budget')
          break
        }
        if (loops >= (this.options.maxToolLoopsPerTurn ?? 25)) {
          await this.emit('error.raised', turnId, { code: 'tool_loop_exhausted', loopCount: loops })
          break
        }
        loops += 1
        decision =
          retryDecision ??
          (sticky
            ? { provider: sticky, model: decision?.model ?? '', reason: 'sticky-provider' }
            : await this.router.pick(
                this.routerContext(turnId, attempts, turnStartedAt, signal),
                routerHint,
              ))
        retryDecision = undefined
        const system = await this.promptComposer.compose({
          cwd: this.#state.cwd,
          model: decision.model,
          provider: decision.provider.name,
        })
        if (this.#state.systemPromptSnapshot !== system)
          this.#state = updateSession(this.#state, (draft) => {
            draft.systemPromptSnapshot = system
          })
        let requestMessages = this.#state.messages
        if (this.contextPolicy) {
          const context = {
            session: this.#state,
            capabilities: decision.provider.capabilities,
            turnId,
            model: decision.model,
            systemTokens: this.contextPolicy.estimateTokens(system, decision.model),
            toolSchemaTokens: Math.ceil(
              JSON.stringify(this.tools.schemas(decision.provider)).length / 3.5,
            ),
          }
          if (this.contextPolicy.shouldCompact(context)) {
            this.#state = updateSession(this.#state, (draft) => {
              const turn = draft.turns.find((item) => item.id === turnId)
              if (turn) turn.status = 'compacting'
            })
            const snapshot = await this.contextPolicy.compact(context)
            this.#state = updateSession(this.#state, (draft) => {
              draft.messages = [...snapshot.messages]
              const turn = draft.turns.find((item) => item.id === turnId)
              if (turn) turn.status = 'streaming'
            })
            await this.emit('context.compacted', turnId, {
              strategy: snapshot.strategy,
              beforeTokens: snapshot.beforeTokens,
              afterTokens: snapshot.afterTokens,
              compactedCount: snapshot.compactedMessageIds.length,
              hookIntercepted: snapshot.hookIntercepted,
            })
          }
          requestMessages = this.contextPolicy.buildPrompt({
            ...context,
            session: this.#state,
          }).messages
        }
        requestMessages = messagesForCapabilities(
          requestMessages,
          decision.provider.name,
          decision.provider.capabilities,
        )
        await this.emit('stream.started', turnId, {
          provider: decision.provider.name,
          model: decision.model,
        })
        const current: InProgress = {
          text: '',
          thinking: '',
          tools: new Map(),
          invalidTools: new Set(),
        }
        let interrupted = false
        for await (const chunk of decision.provider.stream(
          {
            model: decision.model,
            messages: requestMessages,
            system,
            tools: this.tools.schemas(decision.provider),
          },
          signal,
        )) {
          if (signal.aborted) break outer
          if (chunk.kind === 'tool_use.start') sticky ??= decision.provider
          if (chunk.kind === 'message.interrupted') {
            interrupted = true
            const hadPartialToolUse = current.tools.size > 0
            // §3.2 rule 4：interrupted 到达时所有聚合 entry（含已 end 的）连同所在 message 作废，
            // 不落盘、不执行、不产生 tool_result（见 §3.9a）。
            current.tools.clear()
            current.invalidTools.clear()
            await this.emit('error.raised', turnId, {
              code: 'stream_interrupted',
              reason: chunk.reason,
              hadPartialToolUse,
            })
            if (hadPartialToolUse) {
              failed = true
              await this.emit('error.raised', turnId, {
                code: 'stream_resume_unsafe_partial_tool_use',
                reason: 'partial tool_use cannot be resumed or replayed safely',
              })
              break outer
            }
            const error = Object.assign(new Error(chunk.reason), {
              provider: decision.provider.name,
              model: decision.model,
              category: 'stream_truncated',
              retryable: true,
            }) as ProviderError
            const next = await this.router.onError(
              error,
              this.routerContext(turnId, attempts++, turnStartedAt, signal, sticky?.name),
            )
            if (next === 'give-up') {
              failed = true
              break outer
            }
            if (sticky && next.provider !== sticky) {
              failed = true
              await this.emit('error.raised', turnId, {
                code: 'provider_sticky_violation',
                reason: 'tool_use already in flight, cannot switch provider',
              })
              break outer
            }
            if (next.provider !== decision.provider)
              await this.emit('router.switched', turnId, {
                from: decision.provider.name,
                to: next.provider.name,
                reason: next.reason,
                category: error.category,
              })
            retryDecision = next
            continue outer
          }
          this.merge(current, chunk)
          await this.emit('stream.delta', turnId, { chunk: chunk as unknown as JsonValue })
        }
        if (interrupted) continue
        if (signal.aborted) break
        await this.router.onSuccess?.(
          decision,
          this.routerContext(turnId, attempts, turnStartedAt, signal, sticky?.name),
        )
        const assistant = this.finish(current, decision)
        this.append(assistant)
        if (current.usage)
          this.#state = updateSession(this.#state, (draft) => {
            draft.cumulativeUsage.input += current.usage!.input
            draft.cumulativeUsage.output += current.usage!.output
            draft.cumulativeUsage.cacheRead =
              (draft.cumulativeUsage.cacheRead ?? 0) + (current.usage!.cacheRead ?? 0)
            draft.cumulativeUsage.cacheWrite =
              (draft.cumulativeUsage.cacheWrite ?? 0) + (current.usage!.cacheWrite ?? 0)
            draft.cumulativeUsage.costUSD += current.usage!.costUSD ?? 0
          })
        await this.emit('stream.completed', turnId, { messageId: assistant.id })
        await this.emit('message.appended', turnId, { messageId: assistant.id })
        const toolUses = assistant.content.filter(
          (part): part is Extract<ContentPart, { type: 'tool_use' }> => part.type === 'tool_use',
        )
        if (toolUses.length === 0) break
        toolCalls += toolUses.length
        const results = await Promise.all(
          toolUses.map(async (tool) => {
            if (current.invalidTools.has(tool.id)) {
              // §3.2 rule 2：parse 失败的 tool_use 不执行，直接以固定格式的 error tool_result 返模型。
              const raw = current.tools.get(tool.id)?.raw ?? ''
              return {
                toolUseId: tool.id,
                toolName: tool.name,
                content: [
                  {
                    type: 'text' as const,
                    text: `Invalid JSON arguments for tool ${tool.name} (stream truncated?): ${raw.slice(0, 200)}...`,
                  },
                ],
                isError: true,
              } satisfies ToolExecution
            }
            await this.emit('tool.started', turnId, {
              toolUseId: tool.id,
              toolName: tool.name,
              input: tool.input as unknown as JsonValue,
            })
            return this.tools.execute(tool, signal)
          }),
        )
        for (const result of results) {
          const message = this.message('user', [
            {
              type: 'tool_result',
              toolUseId: result.toolUseId,
              content: wrapUntrusted(
                result.content,
                `tool:${result.toolName ?? 'unknown'}`,
                result.toolUseId,
              ),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
            },
          ])
          this.append(message)
          await this.emit('tool.completed', turnId, {
            toolUseId: result.toolUseId,
            toolName: result.toolName ?? 'unknown',
            content: result.content as unknown as JsonValue,
            isError: result.isError ?? false,
          })
          await this.emit('message.appended', turnId, { messageId: message.id })
        }
      }
    } catch (error) {
      failed = true
      await this.emit('error.raised', turnId, {
        code: 'runner_error',
        message: error instanceof Error ? error.message : String(error),
        ...(decision
          ? {
              provider: decision.provider.name,
              model: decision.model,
            }
          : {}),
      })
    }
    const aborted = failed || signal.aborted || this.#state.pendingInterrupt
    this.#state = updateSession(this.#state, (draft) => {
      draft.activeTurn = null
      const turn = draft.turns.find((item) => item.id === turnId)
      if (turn) turn.status = aborted ? 'aborted' : 'done'
    })
    await this.emit(aborted ? 'turn.aborted' : 'turn.completed', turnId, {
      status: failed ? 'error' : aborted ? 'cancelled' : 'completed',
      exitCode: failed ? 1 : aborted ? 130 : 0,
    })
    return this.#state
  }
  private exhaustedBudget(
    startedAt: number,
    toolCalls: number,
  ): 'token' | 'cost' | 'time' | 'tool-call' | undefined {
    const budget = this.options.budget ?? this.#state.resourceBudget
    if (!budget) return
    if (
      budget.tokenMax !== undefined &&
      this.#state.cumulativeUsage.input + this.#state.cumulativeUsage.output >= budget.tokenMax
    )
      return 'token'
    if (budget.costUSDMax !== undefined && this.#state.cumulativeUsage.costUSD >= budget.costUSDMax)
      return 'cost'
    if (budget.timeMsMax !== undefined && Date.now() - startedAt >= budget.timeMsMax) return 'time'
    if (budget.toolCallMax !== undefined && toolCalls >= budget.toolCallMax) return 'tool-call'
  }
  private routerContext(
    turnId: string,
    attemptCount: number,
    startedAt: number,
    signal: AbortSignal,
    stickyProvider?: string,
  ) {
    const budget = this.options.budget ?? this.#state.resourceBudget
    return {
      session: {
        id: this.#state.id,
        cumulativeCostUSD: this.#state.cumulativeUsage.costUSD,
        ...(stickyProvider === undefined ? {} : { stickyProvider }),
      },
      turnId,
      attemptCount,
      ...(budget
        ? {
            budget: {
              ...(budget.costUSDMax === undefined ? {} : { costUSDMax: budget.costUSDMax }),
              ...(budget.timeMsMax === undefined ? {} : { timeMsMax: budget.timeMsMax }),
            },
          }
        : {}),
      elapsedTimeMs: Date.now() - startedAt,
      signal,
    }
  }
  private message(role: Message['role'], content: ContentPart[]): Message {
    return { id: uuidv7(), role, content, createdAt: Date.now() }
  }
  private append(message: Message): void {
    this.#state = updateSession(this.#state, (draft) => {
      draft.messages = [...draft.messages, message]
    })
  }
  private async emit(
    type: Parameters<EventBus['emit']>[0]['type'],
    turnId: string,
    payload: JsonValue,
  ): Promise<void> {
    await this.events.emit({
      type,
      version: this.#state.version,
      sessionId: this.#state.id,
      turnId,
      payload,
    })
  }
  private merge(current: InProgress, chunk: ProviderChunk): void {
    if (chunk.kind === 'text.delta') current.text += chunk.text
    else if (chunk.kind === 'thinking.delta') current.thinking += chunk.text
    else if (chunk.kind === 'tool_use.start')
      current.tools.set(chunk.id, { id: chunk.id, name: chunk.name, fragments: [] })
    else if (chunk.kind === 'tool_use.delta') {
      current.tools.get(chunk.id)?.fragments.push(chunk.argsFragment)
    } else if (chunk.kind === 'tool_use.end') this.endToolUse(current, chunk.id)
    else if (chunk.kind === 'usage') current.usage = chunk.usage
    else if (chunk.kind === 'message.stop') current.stopReason = chunk.stopReason
  }
  /** §3.2 rule 1/2：合并全文，一次性 JSON.parse；失败仅标记 invalid，不在此构造 tool_result。 */
  private endToolUse(current: InProgress, id: string): void {
    const tool = current.tools.get(id)
    if (!tool || tool.ended) return
    tool.ended = true
    tool.raw = tool.fragments.join('')
    try {
      tool.input = JSON.parse(tool.raw) as JsonValue
    } catch {
      current.invalidTools.add(tool.id)
    }
  }
  private finish(current: InProgress, decision: RouterDecision): Message {
    const content: ContentPart[] = []
    if (current.thinking) content.push({ type: 'thinking', text: current.thinking })
    if (current.text) content.push({ type: 'text', text: current.text })
    for (const tool of current.tools.values()) {
      // 防御：provider 流缺 tool_use.end 就 message.stop 时，仍按累计片段定稿
      this.endToolUse(current, tool.id)
      content.push({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input !== undefined ? tool.input : { parseError: true, raw: tool.raw ?? '' },
      })
    }
    const message = this.message('assistant', content)
    message.meta = {
      provider: decision.provider.name,
      model: decision.model,
      ...(current.usage ? { usage: current.usage } : {}),
      ...(current.stopReason ? { stopReason: current.stopReason } : {}),
    }
    return message
  }
}

export function messagesForCapabilities(
  messages: readonly Message[],
  provider: string,
  capabilities: ProviderClient['capabilities'],
): readonly Message[] {
  let changed = false
  const mapped = messages.map((message) => {
    const content = message.content.flatMap((part): ContentPart[] => {
      if (part.type === 'image' && capabilities.vision === false) {
        changed = true
        return [
          {
            type: 'text',
            text: `[Attachment omitted: provider ${provider} does not support vision (${part.mime})]`,
          },
        ]
      }
      if (part.type === 'file' && capabilities.files === false) {
        changed = true
        return [
          {
            type: 'text',
            text: `[Attachment omitted: provider ${provider} does not support files (${part.filename}, ${part.mime})]`,
          },
        ]
      }
      return [part]
    })
    return content === message.content ? message : { ...message, content }
  })
  return changed ? mapped : messages
}

export function wrapUntrusted(
  parts: ContentPart[],
  source: string,
  toolUseId?: string,
): ContentPart[] {
  const escape = (text: string) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const body = parts
    .map((part) => (part.type === 'text' ? part.text : JSON.stringify(part)))
    .join('\n')
  const id = toolUseId ? ` toolUseId="${escape(toolUseId)}"` : ''
  return [
    {
      type: 'text',
      text: `<untrusted source="${escape(source)}"${id}>\n${escape(body)}\n</untrusted>`,
    },
  ]
}
