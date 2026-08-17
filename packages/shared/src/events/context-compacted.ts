import { z } from 'zod'

/** 附录 D.2 `context.compacted`：★before ★after（token 数） ?strategy ?removedMessageIds。 */
export const contextCompactedPayloadSchema = z.strictObject({
  before: z.number().int().nonnegative(),
  after: z.number().int().nonnegative(),
  strategy: z.string().optional(),
  removedMessageIds: z.array(z.string()).optional(),
})
export type ContextCompactedPayload = z.infer<typeof contextCompactedPayloadSchema>
