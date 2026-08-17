import { z } from 'zod'

/** 附录 D.2 `turn.aborted`：★turnId ★reason（user_interrupt|error|stream_interrupted）。 */
export const turnAbortedPayloadSchema = z.strictObject({
  turnId: z.string().min(1),
  reason: z.enum(['user_interrupt', 'error', 'stream_interrupted']),
})
export type TurnAbortedPayload = z.infer<typeof turnAbortedPayloadSchema>
