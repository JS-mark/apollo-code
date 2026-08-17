import { z } from 'zod'

/** 附录 D.2 `turn.started`：★turnId ?parentTurnId ?agentType（subagent 冒泡保留原 event.id）。 */
export const turnStartedPayloadSchema = z.strictObject({
  turnId: z.string().min(1),
  parentTurnId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
})
export type TurnStartedPayload = z.infer<typeof turnStartedPayloadSchema>
