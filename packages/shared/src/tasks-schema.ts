import { z } from 'zod'

/**
 * 定时任务契约（spec 22-web-console.md W-17 / Web 计划 F1-02 Task contract）。
 *
 * 任务定义是创建时冻结的模板（F1-02）：cwd / config hash / 模型 / 预算 / 工具
 * 白名单 / 超时 / 重试在创建时写死；daemon 每次运行前重算 config hash 与 trust
 * 比对（F1-03），漂移即拒绝。schema 层面不存在任何提权/跳过权限字段
 * （strictObject 拒绝未知 key）——F1-02「禁存 dangerous-skip」由形状保证：
 * 没有可存的地方；无人值守运行时默认 deny 未预授权能力的语义落在 daemon 执行路径。
 *
 * 事件面：任务生命周期（scheduled/fired/completed/failed）记录在 TaskStore
 * journal（packages/storage/task-store.ts），不进 §2.3 会话事件流——事件总线
 * 是会话作用域，任务生命周期跨会话（daemon 进程级）。
 */

/** `HH:MM`（24 小时制，本地墙钟，时区见 TaskDefinition.timezone）。 */
const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'expected HH:MM (24h)')

/**
 * v1 调度面：interval / daily / weekly 三种（覆盖定时轮询与每日常规作业）。
 * discriminatedUnion 便于后续以新 kind 扩展 cron 语法（纯增量）。
 * weekday 沿 JS 约定 0=Sunday。
 */
export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), everyMs: z.number().int().min(60_000) }),
  z.strictObject({ kind: z.literal('daily'), at: hhmmSchema }),
  z.strictObject({
    kind: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    at: hhmmSchema,
  }),
])
export type TaskSchedule = z.infer<typeof taskScheduleSchema>

/** 单次运行的资源上限（F1-02 budget）；字段全部可选，缺省 = 会话默认。 */
export const taskRunBudgetSchema = z.strictObject({
  costUSDMax: z.number().positive().optional(),
  tokenMax: z.number().int().positive().optional(),
  timeMsMax: z.number().int().positive().optional(),
})
export type TaskRunBudget = z.infer<typeof taskRunBudgetSchema>

/**
 * 创建时冻结的运行约束（F1-02）。`network` 域暂不收录：当前会话没有按任务
 * 收窄网络域的执行钩子，schema 先行会是没有消费方的死字段——随执行路径
 * （daemon spawn）一起落地。`allowedTools` 缺省 = 会话默认注册面。
 */
export const taskRunConstraintsSchema = z.strictObject({
  model: z.string().min(1).optional(),
  budget: taskRunBudgetSchema.optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  /** 单次运行 wall-clock 上限（不含重试）；缺省 = daemon 默认值。 */
  timeoutMs: z.number().int().min(1_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
})
export type TaskRunConstraints = z.infer<typeof taskRunConstraintsSchema>

/** IANA 时区名（如 `Asia/Shanghai`）；缺省 = 调度器宿主本地时区。 */
const timezoneSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    } catch {
      return false
    }
  }, 'expected an IANA time zone identifier')

/**
 * 任务定义（F1-02 frozen task contract）。错过的窗口策略 missedRun 与在途
 * 重叠策略 overlap 是 daemon 补跑/串行语义（F1-04）的每任务开关：
 * - missedRun: `skip` 丢弃错过的窗口；`run_latest` 补跑最近一个错过窗口（仅一次）。
 * - overlap: `skip` 上轮在途时丢弃本轮；`queue` 排队等待上轮释放。
 */
export const taskDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'expected kebab-case task id'),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  /** 触发时提交给 headless 会话的非交互 prompt。 */
  prompt: z
    .string()
    .min(1)
    .max(32 * 1024),
  /** 创建时冻结的工作目录（绝对路径）；运行时重验 trust（F1-03）。 */
  cwd: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
      'expected an absolute path',
    ),
  schedule: taskScheduleSchema,
  timezone: timezoneSchema.optional(),
  missedRun: z.enum(['skip', 'run_latest']),
  overlap: z.enum(['skip', 'queue']),
  constraints: taskRunConstraintsSchema.optional(),
  /** 创建时的 config.toml 内容 hash；daemon 运行前重算比对（F1-03），漂移即拒绝。 */
  configHash: z.string().min(8).optional(),
  createdAt: z.number().int().positive(),
})
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>

export type TaskDefinitionIssue = { path: string; message: string }

/** 校验失败返回逐条 issue（不抛），由调用方决定报错形态。 */
export function validateTaskDefinition(
  value: unknown,
): { ok: true; value: TaskDefinition } | { ok: false; issues: readonly TaskDefinitionIssue[] } {
  const parsed = taskDefinitionSchema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  }
}

/** 周内每天的第 0..N 次匹配的墙钟锚点解析辅助（调度核心用，避免重复实现）。 */
export function parseHhmm(at: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at)
  if (!match) throw new RangeError(`invalid HH:MM: ${at}`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}
