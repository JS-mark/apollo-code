import { z } from 'zod'

/** 附录 D.2 `tool.completed`：★toolUseId ★tool ★isError ?durationMs ?blocked ?blockedBy（hook）。 */
export const toolCompletedPayloadSchema = z.strictObject({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  blocked: z.boolean().optional(),
  blockedBy: z.literal('hook').optional(),
})
export type ToolCompletedPayload = z.infer<typeof toolCompletedPayloadSchema>
