import { z } from 'zod'

/** 附录 D.2 `session.ended`：★reason（exit|signal|error） ?exitCode（触发后台 shell 统一 kill）。 */
export const sessionEndedPayloadSchema = z.strictObject({
  reason: z.enum(['exit', 'signal', 'error']),
  exitCode: z.number().int().optional(),
})
export type SessionEndedPayload = z.infer<typeof sessionEndedPayloadSchema>
