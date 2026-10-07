/**
 * 审批卡 display.spec 解析（移动端）：display.spec 是网关投影的注入式 JSON 串
 * （app-runtime formatPermissionValueForDisplay）。这里还原成结构化能力行——
 * 授权面读「写入 /Users/…」而不是裸 JSON；解析失败（非 JSON/超出展示预算）回退
 * 原文展示，绝不猜测。
 *
 * 能力行口径与 TUI 的 summarizeSpec（packages/ui）同源：fs.read/write、
 * bash.command、net.method+url、env.read、custom.*。
 */

import { pickCopy, SPEC_KIND_LABELS } from '@volund/shared/ui-copy'

import { currentLocale } from './i18n'

/** 一条能力行：kind 决定配色（write/run 提示副作用，read/net 偏中性）。 */
export interface PermissionSpecLine {
  kind: 'read' | 'write' | 'run' | 'net' | 'env' | 'custom'
  label: string
  value: string
}

/** 能力行标签（shared 跨端文案表权威，i18n-r1 收编双份手抄；TUI 取 en）。 */
export function specKindLabel(kind: PermissionSpecLine['kind']): string {
  return pickCopy(SPEC_KIND_LABELS[kind], currentLocale())
}

/**
 * display.spec 里的不安全字符以 `\u{HEX}` 转义（如多行命令的 `\u{000A}`）——
 * 这不是合法 JSON 转义，JSON.parse 前归一成 `\uXXXX`（>FFFF 拆 UTF-16 代理对）。
 */
export function normalizeSpecEscapes(spec: string): string {
  return spec.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (token, hex: string) => {
    const codePoint = Number.parseInt(hex, 16)
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return token
    if (codePoint <= 0xffff) return `\\u${hex.padStart(4, '0').slice(-4)}`
    const offset = codePoint - 0x10000
    const high = (Math.floor(offset / 0x400) + 0xd800).toString(16).padStart(4, '0')
    const low = ((offset % 0x400) + 0xdc00).toString(16).padStart(4, '0')
    return `\\u${high}\\u${low}`
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringArrayOf(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined
  return value as string[]
}

/** 结构化 spec → 能力行（spec 不是 plain object 时为空——调用方回退原文）。 */
export function summarizePermissionSpec(spec: unknown): readonly PermissionSpecLine[] {
  const record = asRecord(spec)
  if (!record) return []
  const lines: PermissionSpecLine[] = []
  const push = (kind: PermissionSpecLine['kind'], value: string) =>
    lines.push({ kind, label: specKindLabel(kind), value })
  const fs = asRecord(record.fs)
  for (const key of ['read', 'write'] as const) {
    const paths = fs ? stringArrayOf(fs, key) : undefined
    if (paths?.length) push(key, paths.join('\n'))
  }
  const bash = asRecord(record.bash)
  if (bash && typeof bash.command === 'string') push('run', `$ ${bash.command}`)
  const net = asRecord(record.net)
  if (net && typeof net.method === 'string' && typeof net.url === 'string')
    push('net', `${net.method} ${net.url}`)
  const env = asRecord(record.env)
  const envKeys = env ? stringArrayOf(env, 'read') : undefined
  if (envKeys?.length) push('env', envKeys.join(', '))
  const custom = asRecord(record.custom)
  if (custom)
    for (const [key, value] of Object.entries(custom)) {
      let rendered: string
      try {
        rendered = JSON.stringify(value) ?? 'undefined'
      } catch {
        rendered = '[unserializable]'
      }
      push('custom', `${key} ${rendered}`)
    }
  return lines
}

export interface PermissionSpecView {
  /** 结构化能力行；spec 无法解析时为空数组。 */
  lines: readonly PermissionSpecLine[]
  /** 美化 JSON（2 空格缩进）；解析失败时 undefined——UI 回退 display.spec 原文。 */
  pretty?: string
}

/** display 面字符串 → 能力行 + 美化 JSON。不可审批（占位文案）恒为空面。 */
export function parsePermissionDisplaySpec(approvable: boolean, spec: string): PermissionSpecView {
  if (!approvable) return { lines: [] }
  try {
    const value: unknown = JSON.parse(normalizeSpecEscapes(spec))
    return { lines: summarizePermissionSpec(value), pretty: JSON.stringify(value, null, 2) }
  } catch {
    return { lines: [] }
  }
}
