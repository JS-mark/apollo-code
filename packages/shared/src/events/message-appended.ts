import { z } from 'zod'

import { contentPartSchema } from './common'

/** 附录 D.2 `message.appended`：★messageId ★role ★content（ContentPart[]，引用式）。 */
export const messageAppendedPayloadSchema = z.strictObject({
  messageId: z.string().min(1),
  role: z.enum(['assistant', 'system', 'user']),
  content: z.array(contentPartSchema),
})
export type MessageAppendedPayload = z.infer<typeof messageAppendedPayloadSchema>
