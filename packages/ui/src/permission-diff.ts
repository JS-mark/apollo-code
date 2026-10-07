import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { countDiffLines, diffLineOps, type DiffLineOp } from '@volund/shared'

import { formatPermissionTextForDisplay } from './permission-display'

/**
 * 权限卡的写操作 diff 预览（Edit/MultiEdit 旧串→新串；Write 新内容头部）。
 *
 * 输入是模型产出的不可信文本：逐行过 SafeDisplay 注入安全转义后再截断——
 * 转义产生的 NEWLINE_TOKEN 也压成空格，保证一行预览就是一行终端输出。
 * 行数有硬上限，超限以 meta 行收口（带全量 +n −m 计数），卡片永不撑爆。
 */

export type PermissionDiffTone = 'add' | 'del' | 'meta'

export interface PermissionDiffRow {
  tone: PermissionDiffTone
  text: string
}

/** permission-display 对换行的注入安全转义 token。 */
const NEWLINE_TOKEN = '\\u{000A}'
/** diff 正文行总上限（meta 行不计）。 */
const MAX_ROWS = 12
const WRITE_HEAD_LINES = 6
const MULTI_EDIT_MAX_SHOWN = 3
/** §4.6：Edit/MultiEdit 改动超过该行数 → 预览首行加「大规模变更」提示。 */
const LARGE_CHANGE_LINES = 100

/** 大规模变更提示行（§4.6；tone=meta 由渲染层配色，此处只给文本）。 */
function largeChangeRow(totalLines: number): PermissionDiffRow {
  return {
    tone: 'meta',
    text: `⚠ Large change: ${totalLines} lines in total — review before approving`,
  }
}

function escapeLine(line: string, maxWidth: number): string {
  const escaped = formatPermissionTextForDisplay(line).text
  const oneLine = escaped.split(NEWLINE_TOKEN).join(' ')
  return oneLine.length > maxWidth ? `${oneLine.slice(0, Math.max(1, maxWidth - 1))}…` : oneLine
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function rowsOfOps(
  ops: readonly DiffLineOp[],
  budget: number,
  maxWidth: number,
): { rows: PermissionDiffRow[]; used: number } {
  const rows: PermissionDiffRow[] = []
  for (const op of ops) {
    if (op.type === 'context' || rows.length >= budget) continue
    rows.push({
      tone: op.type === 'add' ? 'add' : 'del',
      text: escapeLine(op.text, maxWidth),
    })
  }
  return { rows, used: rows.length }
}

/**
 * 生成权限卡的 diff 预览行；非写工具 / 形状不符返回空（卡片不渲染该区）。
 * maxWidth 为文本列宽（已扣除 +/- 标记列）。
 *
 * cwd 提供时做「审批时点」的只读探测（P3/P5）：Write 明示是否覆盖现有文件
 * （带大小）；Edit 校验 old_string 在当前文件内容里的出现处数——批准前
 * 就能发现「文件已被外部修改、执行将失败」。超过 1MB 的文件跳过探测。
 */
export function permissionDiffPreview(
  toolName: string,
  input: unknown,
  maxWidth: number,
  cwd?: string,
): readonly PermissionDiffRow[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  const width = Math.max(8, maxWidth)
  if (toolName === 'Edit') {
    const oldString = stringField(record, 'old_string')
    const newString = record.new_string
    if (typeof newString !== 'string' || oldString === undefined) return []
    const ops = diffLineOps(oldString, newString)
    const counts = countDiffLines(ops)
    if (counts.linesAdded + counts.linesRemoved === 0) return []
    const { rows } = rowsOfOps(ops, MAX_ROWS, width)
    // replace_all：工具执行的是「所有出现处」替换，预览须明示批量语义，
    // 否则「批准一处替换」和「执行 N 处替换」不一致。
    const replaceAll = record.replace_all === true
    // P5 审批时点探测：old_string 在当前文件里是否还匹配——审批-执行之间
    // 文件被外部修改时，工具会以 changedSinceReadError 失败；此处提前亮出。
    const warnings = cwd ? editProbeWarnings(cwd, record.path, oldString, replaceAll) : []
    const large =
      counts.linesAdded + counts.linesRemoved > LARGE_CHANGE_LINES
        ? [largeChangeRow(counts.linesAdded + counts.linesRemoved)]
        : []
    if (countChanges(ops) > rows.length)
      return [
        ...large,
        ...warnings,
        ...rows,
        {
          tone: 'meta',
          text: `… +${counts.linesAdded} −${counts.linesRemoved} lines in total${replaceAll ? ' (replace all occurrences)' : ''}`,
        },
      ]
    return [
      ...large,
      ...warnings,
      ...rows,
      ...(replaceAll ? [{ tone: 'meta' as const, text: '(replace all occurrences)' }] : []),
    ]
  }
  if (toolName === 'Write') {
    const content = record.content
    if (typeof content !== 'string') return []
    // P3 覆盖警告：审批时目标已存在 → 明示「将覆盖现有文件」（带大小）；
    // 不存在的目标 = 新建，无需提醒。渲染期只读探测（statSync），无副作用。
    const path = stringField(record, 'path')
    const existingSize = cwd && path !== undefined ? existingFileSize(cwd, path) : undefined
    const overwriteNote =
      path !== undefined && existingSize !== undefined
        ? `Will overwrite existing file ${escapeLine(path, width)} (currently ${formatBytes(existingSize)})`
        : undefined
    if (content === '')
      return [
        ...(overwriteNote ? [{ tone: 'meta' as const, text: overwriteNote }] : []),
        { tone: 'meta' as const, text: 'Writing an empty file' },
      ]
    const lines = content.split('\n')
    // 末尾换行不算一行（与 diff 的 splitLines 约定一致）。
    const total = lines.at(-1) === '' ? lines.length - 1 : lines.length
    const head = lines.slice(0, Math.min(WRITE_HEAD_LINES, total))
    const rows: PermissionDiffRow[] = [
      ...(overwriteNote ? [{ tone: 'meta' as const, text: overwriteNote }] : []),
      { tone: 'meta', text: `New content: ${total} lines (showing first ${head.length})` },
      ...head.map((line) => ({ tone: 'add' as const, text: escapeLine(line, width) })),
    ]
    if (total > head.length)
      rows.push({ tone: 'meta', text: `… ${total - head.length} more lines` })
    return rows
  }
  if (toolName === 'MultiEdit') {
    const edits = record.edits
    if (!Array.isArray(edits)) return []
    // 总预算 = 正文行上限 + 尾部「合计」一行（「其余已省略」与收口 meta 都在预算内计数）。
    const bodyBudget = MAX_ROWS
    const rows: PermissionDiffRow[] = []
    let linesAdded = 0
    let linesRemoved = 0
    let shown = 0
    let truncated = false
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) continue
      const entry = edit as Record<string, unknown>
      const path = stringField(entry, 'path')
      const oldString = stringField(entry, 'old_string')
      const newString = entry.new_string
      if (typeof newString !== 'string' || path === undefined || oldString === undefined) continue
      const ops = diffLineOps(oldString, newString)
      const counts = countDiffLines(ops)
      linesAdded += counts.linesAdded
      linesRemoved += counts.linesRemoved
      // 路径行占 1、收口 meta 占 1——预留给它们后才轮到 +/- 正文行。
      if (shown >= MULTI_EDIT_MAX_SHOWN || rows.length + 2 > bodyBudget) {
        truncated = true
        continue
      }
      shown++
      rows.push({ tone: 'meta', text: escapeLine(path, width) })
      const budget = Math.min(bodyBudget - rows.length - 1, 4)
      const { rows: editRows } = rowsOfOps(ops, budget, width)
      rows.push(...editRows)
      if (countChanges(ops) > editRows.length)
        rows.push({
          tone: 'meta',
          text: `… +${counts.linesAdded} −${counts.linesRemoved} lines here`,
        })
    }
    if (rows.length === 0) return []
    const totalLines = linesAdded + linesRemoved
    if (totalLines > LARGE_CHANGE_LINES) rows.unshift(largeChangeRow(totalLines))
    if (truncated) rows.push({ tone: 'meta', text: '… remaining edits omitted' })
    rows.push({ tone: 'meta', text: `Total: +${linesAdded} −${linesRemoved} lines` })
    return rows
  }
  return []
}

function countChanges(ops: readonly DiffLineOp[]): number {
  let total = 0
  for (const op of ops) if (op.type !== 'context') total++
  return total
}

/** 渲染期只读探测：目标是已存在的常规文件时返回其字节数，否则 undefined。 */
function existingFileSize(cwd: string, path: string): number | undefined {
  try {
    const info = statSync(resolve(cwd, path))
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/** 超过该大小的 Edit 目标不读内容（审批预览只读 1MB 以内的文件）。 */
const EDIT_PROBE_MAX_BYTES = 1024 * 1024

/**
 * Edit 的审批时点校验：读当前文件内容，统计 old_string 出现处数。
 * 返回 meta 警告行（0 处 = 已变；多处且非 replace_all = 将失败；
 * replace_all 多处 = 明示次数）。探测失败/超限不告警（宁缺勿滥）。
 */
function editProbeWarnings(
  cwd: string,
  pathValue: unknown,
  oldString: string,
  replaceAll: boolean,
): PermissionDiffRow[] {
  if (typeof pathValue !== 'string' || pathValue === '') return []
  let content: string
  try {
    const resolved = resolve(cwd, pathValue)
    const info = statSync(resolved)
    if (!info.isFile() || info.size > EDIT_PROBE_MAX_BYTES) return []
    content = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }
  const occurrences = content.split(oldString).length - 1
  if (occurrences === 0)
    return [
      {
        tone: 'meta',
        text: '⚠ The target file no longer contains this text (may have been modified externally)',
      },
    ]
  if (replaceAll && occurrences > 1)
    return [{ tone: 'meta', text: `Will replace all ${occurrences} occurrences` }]
  if (!replaceAll && occurrences > 1)
    return [
      {
        tone: 'meta',
        text: `⚠ This text appears ${occurrences} times in the file; replace_all is not set, so the edit will fail`,
      },
    ]
  return []
}

/** 人可读大小（KB 一位小数，MB 一位小数）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
