import { sanitize, type JsonValue } from '@apollo-code/shared'

import type { CoreEvent } from './event-bus'

export const machineOutputVersion = 1 as const

export type MachineEventType =
  | 'message.start'
  | 'text.delta'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'router.switched'
  | 'usage'
  | 'final'

export interface MachineEvent {
  v: typeof machineOutputVersion
  type: MachineEventType
  seq: number
  sessionId: string
  turnId?: string
  timestamp: string
  data: JsonValue
}

export class MachineEventFormatter {
  #sequence = 0

  format(event: CoreEvent): MachineEvent | undefined {
    const base = {
      v: machineOutputVersion,
      seq: ++this.#sequence,
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      timestamp: new Date(event.at).toISOString(),
    }
    const payload = sanitize(event.payload)
    if (event.type === 'stream.delta') {
      const chunk = (payload as { chunk?: Record<string, JsonValue> }).chunk
      if (!chunk) return
      if (chunk.kind === 'message.start')
        return { ...base, type: 'message.start', data: { messageId: chunk.messageId ?? '' } }
      if (chunk.kind === 'text.delta')
        return { ...base, type: 'text.delta', data: { text: chunk.text ?? '' } }
      if (typeof chunk.kind === 'string' && chunk.kind.startsWith('tool_use.'))
        return {
          ...base,
          type: 'tool_use',
          data: { phase: chunk.kind.slice('tool_use.'.length), ...withoutKind(chunk) },
        }
      if (chunk.kind === 'usage') return { ...base, type: 'usage', data: chunk.usage ?? {} }
      return
    }
    if (event.type === 'tool.completed') return { ...base, type: 'tool_result', data: payload }
    if (event.type === 'router.switched') return { ...base, type: 'router.switched', data: payload }
    if (event.type === 'error.raised') {
      const error = payload as Record<string, JsonValue>
      return {
        ...base,
        type: 'error',
        data: {
          ...error,
          code: typeof error.code === 'string' ? error.code : 'internal_error',
          category: typeof error.category === 'string' ? error.category : 'runtime',
          retryable: error.retryable === true,
          exitCode: typeof error.exitCode === 'number' ? error.exitCode : 1,
        },
      }
    }
    if (event.type === 'turn.completed' || event.type === 'turn.aborted')
      return {
        ...base,
        type: 'final',
        data:
          event.type === 'turn.completed'
            ? { status: 'completed', exitCode: 0 }
            : {
                status:
                  (payload as { status?: JsonValue }).status === 'error' ? 'error' : 'cancelled',
                exitCode:
                  typeof (payload as { exitCode?: JsonValue }).exitCode === 'number'
                    ? (payload as { exitCode: number }).exitCode
                    : 130,
              },
      }
  }

  encode(event: CoreEvent): string | undefined {
    const formatted = this.format(event)
    return formatted ? `${JSON.stringify(formatted)}\n` : undefined
  }
}

function withoutKind(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const { kind: _kind, ...rest } = value
  return rest
}
