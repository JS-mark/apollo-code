import { z } from 'zod'

/** 附录 D.2 `session.resumed`：★tailTurns ★skippedTurns（W10；恢复时替代 session.started）。 */
export const sessionResumedPayloadSchema = z.strictObject({
  tailTurns: z.number().int().nonnegative(),
  skippedTurns: z.number().int().nonnegative(),
})
export type SessionResumedPayload = z.infer<typeof sessionResumedPayloadSchema>
