import { z } from 'zod'

/** 附录 D.2 `tool.started`：★toolUseId ★tool。 */
export const toolStartedPayloadSchema = z.strictObject({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
})
export type ToolStartedPayload = z.infer<typeof toolStartedPayloadSchema>
