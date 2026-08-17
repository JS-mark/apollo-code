import { z } from 'zod'

import { usageSchema } from './common'

/** 附录 D.2 `turn.completed`：★turnId ★usage（Usage） ?stopReason。 */
export const turnCompletedPayloadSchema = z.strictObject({
  turnId: z.string().min(1),
  usage: usageSchema,
  stopReason: z.string().optional(),
})
export type TurnCompletedPayload = z.infer<typeof turnCompletedPayloadSchema>
