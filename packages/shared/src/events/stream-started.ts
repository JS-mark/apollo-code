import { z } from 'zod'

/** 附录 D.2 `stream.started`：★messageId ?provider ?model。 */
export const streamStartedPayloadSchema = z.strictObject({
  messageId: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
})
export type StreamStartedPayload = z.infer<typeof streamStartedPayloadSchema>
