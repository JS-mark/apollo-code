import { z } from 'zod'

import { taskRunRefSchema } from './task-started'

/**
 * W-17 `task.failed`：任务运行未正常完成。reason 的细节来源：
 * error → 同流早前的 error.raised（context.message）；interrupted → pendingInterrupt。
 * daemon 侧超时击杀（SIGKILL）进程即死、本事件不发——超时失败由 TaskStore
 * journal 与 daemon events 日志记账（journal status=failed + task_run_failed）。
 */
export const taskFailedPayloadSchema = taskRunRefSchema.extend({
  durationMs: z.number().int().nonnegative(),
  reason: z.enum(['error', 'interrupted']),
})
export type TaskFailedPayload = z.infer<typeof taskFailedPayloadSchema>
