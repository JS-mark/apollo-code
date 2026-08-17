import { z } from 'zod'

/**
 * 附录 D.2 `stream.delta`：★messageId ★kind（text|thinking|tool_use） ★fragment（string）。
 * **只传增量片段**，不塞整 chunk；不落盘（§8.2）。
 */
export const streamDeltaPayloadSchema = z.strictObject({
  messageId: z.string().min(1),
  kind: z.enum(['text', 'thinking', 'tool_use']),
  fragment: z.string(),
})
export type StreamDeltaPayload = z.infer<typeof streamDeltaPayloadSchema>
