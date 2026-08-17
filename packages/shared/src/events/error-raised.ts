import { z } from 'zod'

import { jsonValueSchema } from './common'

/** 附录 D.2 `error.raised`：★code（附录 B registry 中的 string） ?category ?context（Record）。 */
export const errorRaisedPayloadSchema = z.strictObject({
  code: z.string().min(1),
  category: z.string().optional(),
  context: z.record(z.string(), jsonValueSchema).optional(),
})
export type ErrorRaisedPayload = z.infer<typeof errorRaisedPayloadSchema>
