import { z } from 'zod'

/** 附录 D.2 `shell.background_started`（r13-G2）：★shellId ★command ★cwd。 */
export const shellBackgroundStartedPayloadSchema = z.strictObject({
  shellId: z.string().min(1),
  command: z.string(),
  cwd: z.string().min(1),
})
export type ShellBackgroundStartedPayload = z.infer<typeof shellBackgroundStartedPayloadSchema>
