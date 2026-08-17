import { z } from 'zod'

/**
 * 附录 D.2 `shell.background_exited`（r13-G2）：★shellId ★exitCode
 * ?reason（exit|killed|session_ended） ?droppedBytes（环形缓冲丢弃量）。
 */
export const shellBackgroundExitedPayloadSchema = z.strictObject({
  shellId: z.string().min(1),
  exitCode: z.number().int(),
  reason: z.enum(['exit', 'killed', 'session_ended']).optional(),
  droppedBytes: z.number().int().nonnegative().optional(),
})
export type ShellBackgroundExitedPayload = z.infer<typeof shellBackgroundExitedPayloadSchema>
