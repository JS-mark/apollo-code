import { z } from 'zod'

/**
 * W-17 任务运行生命周期事件共用工件：daemon 触发的 headless 运行在**自己的
 * 会话流**里发射 task.*（runId 由 TaskStore journal 颁发，scheduledFor 与
 * journal/游标同源）。调度决策类事件（missed/skipped/fired）无会话载体，
 * 不进 §2.3——它们记录在 TaskStore journal 与 daemon events 日志里。
 */
export const taskRunRefSchema = z.strictObject({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  /** 本次窗口应触发时刻（epoch ms）。 */
  scheduledFor: z.number().int().nonnegative(),
})
export type TaskRunRef = z.infer<typeof taskRunRefSchema>

/** W-17 `task.started`：★taskId ★runId ★scheduledFor——任务运行开始。 */
export const taskStartedPayloadSchema = taskRunRefSchema
export type TaskStartedPayload = z.infer<typeof taskStartedPayloadSchema>
