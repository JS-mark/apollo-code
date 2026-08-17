import { z } from 'zod'

/** 附录 D.2 `router.switched`：★from ?to ★reason。 */
export const routerSwitchedPayloadSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().optional(),
  reason: z.string().min(1),
})
export type RouterSwitchedPayload = z.infer<typeof routerSwitchedPayloadSchema>
