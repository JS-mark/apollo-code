import { z } from 'zod'

import type { JsonValue } from '../index'

/**
 * Per-event payload 契约（附录 D）共用的子 schema。
 *
 * shared 不能依赖 provider-kit（后者反向依赖 shared），因此 Usage / ContentPart /
 * PermissionSpec 在事件契约层以结构等价的 zod schema 登记；字段来源标注附录 D 行。
 */

/** 递归 JSON 值（附录 D：payload 必须可 JSON 序列化，二进制只传引用）。 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

/** Usage（turn.completed ★usage / stream.completed ?usage；字段对齐 provider-kit Usage）。 */
export const usageSchema = z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheWrite: z.number().int().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
})
export type EventUsage = z.infer<typeof usageSchema>

/**
 * 附件引用（附录 D.1：大 payload 不进事件，只传引用——inline bytes 禁止出现在事件里）。
 */
export const attachmentRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('path'), absPath: z.string() }),
  z.strictObject({ kind: z.literal('handle'), handle: z.string() }),
])
export type EventAttachmentRef = z.infer<typeof attachmentRefSchema>

/** 递归 ContentPart 的手写输出类型（exactOptionalPropertyTypes 下可选属性带 undefined）。 */
export interface EventTextPart {
  type: 'text'
  text: string
}
export interface EventThinkingPart {
  type: 'thinking'
  text: string
  signature?: string | undefined
}
export interface EventImagePart {
  type: 'image'
  source: EventAttachmentRef
  mime: string
}
export interface EventFilePart {
  type: 'file'
  source: EventAttachmentRef
  mime: string
  filename: string
}
export interface EventToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: JsonValue
}
export interface EventToolResultPart {
  type: 'tool_result'
  toolUseId: string
  content: EventContent[]
  isError?: boolean | undefined
}
export type EventContent =
  | EventTextPart
  | EventThinkingPart
  | EventImagePart
  | EventFilePart
  | EventToolUsePart
  | EventToolResultPart

/** ContentPart[] 引用式（message.appended ★content；tool_result.content 递归）。 */
export const contentPartSchema: z.ZodType<EventContent> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string() }),
    z.strictObject({
      type: z.literal('thinking'),
      text: z.string(),
      signature: z.string().optional(),
    }),
    z.strictObject({
      type: z.literal('image'),
      source: attachmentRefSchema,
      mime: z.string(),
    }),
    z.strictObject({
      type: z.literal('file'),
      source: attachmentRefSchema,
      mime: z.string(),
      filename: z.string(),
    }),
    z.strictObject({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: jsonValueSchema,
    }),
    z.strictObject({
      type: z.literal('tool_result'),
      toolUseId: z.string(),
      content: z.array(contentPartSchema),
      isError: z.boolean().optional(),
    }),
  ]),
)

/** PermissionSpec 摘要（tool.permission_asked ★spec；结构对齐 permission 包 PermissionSpec）。 */
export const permissionSpecSummarySchema = z.strictObject({
  fs: z
    .strictObject({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
    })
    .optional(),
  bash: z.strictObject({ command: z.string() }).optional(),
  net: z
    .strictObject({
      url: z.string(),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    })
    .optional(),
  env: z.strictObject({ read: z.array(z.string()).optional() }).optional(),
  custom: z.record(z.string(), jsonValueSchema).optional(),
})
export type EventPermissionSpecSummary = z.infer<typeof permissionSpecSummarySchema>
