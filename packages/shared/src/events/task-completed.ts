import { z } from 'zod'

import { taskRunRefSchema } from './task-started'

/** W-17 `task.completed`：任务运行正常完成（turn.completed 之后发射）。 */
export const taskCompletedPayloadSchema = taskRunRefSchema.extend({
  /** run 起止墙钟差（turn 计量起点到 turn 收尾）。 */
  durationMs: z.number().int().nonnegative(),
})
export type TaskCompletedPayload = z.infer<typeof taskCompletedPayloadSchema>
