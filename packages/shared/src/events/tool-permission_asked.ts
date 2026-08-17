import { z } from 'zod'

import { permissionSpecSummarySchema } from './common'

/** 附录 D.2 `tool.permission_asked`：★toolUseId ★tool ★spec（PermissionSpec 摘要）。 */
export const toolPermissionAskedPayloadSchema = z.strictObject({
  toolUseId: z.string().min(1),
  tool: z.string().min(1),
  spec: permissionSpecSummarySchema,
})
export type ToolPermissionAskedPayload = z.infer<typeof toolPermissionAskedPayloadSchema>
