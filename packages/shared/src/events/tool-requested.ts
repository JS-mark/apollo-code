import { z } from 'zod'

import { jsonValueSchema } from './common'

/** 附录 D.2 `tool.requested`：★toolUseId ★tool ★input（§8.2 样例）。 */
export const toolRequestedPayloadSchema = z.strictObject({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  input: jsonValueSchema,
})
export type ToolRequestedPayload = z.infer<typeof toolRequestedPayloadSchema>
