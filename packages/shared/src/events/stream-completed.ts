import { z } from 'zod'

import { usageSchema } from './common'

/** 附录 D.2 `stream.completed`：★messageId ?usage（落盘含完整 assistant message）。 */
export const streamCompletedPayloadSchema = z.strictObject({
  messageId: z.string().min(1),
  usage: usageSchema.optional(),
})
export type StreamCompletedPayload = z.infer<typeof streamCompletedPayloadSchema>
