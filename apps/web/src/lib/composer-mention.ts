/**
 * W-05 @-picker 纯函数：与 TUI InputBox 的 mention 语义逐字对齐
 * （packages/ui/src/components/InputBox.tsx:49-73）——光标在末尾、@ 在 token
 * 边界、前缀匹配、上限 50。键盘导航状态由 ChatPanel 持有。
 */

export interface MentionQuery {
  /** @ 后到光标的无空白串（不含 @）。 */
  query: string
}

/** 光标在输入末尾且 @ 处于 token 边界（行首或空白后）时，返回 mention 查询。 */
export function mentionQueryAt(value: string, cursor: number): MentionQuery | undefined {
  if (cursor !== value.length) return undefined
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, cursor))
  if (!match) return undefined
  return { query: match[1] ?? '' }
}

export interface MentionFileCandidate {
  path: string
}

/** 文件候选：大小写不敏感前缀匹配，上限 50（对齐 TUI mentionCandidates）。 */
export function mentionFileCandidates(
  query: string,
  files: readonly string[],
  limit = 50,
): MentionFileCandidate[] {
  const q = query.toLowerCase()
  return files
    .filter((path) => path.toLowerCase().startsWith(q))
    .slice(0, limit)
    .map((path) => ({ path }))
}

/** 选中后从输入中删掉 `@query` token（保留 token 前的空白）；调用方在尾部插入新内容。 */
export function replaceMentionToken(value: string, _query: string): string {
  return value.replace(/(^|\s)@[^\s@]*$/, '$1')
}

/** chip 文本（对齐 TUI selectMention → attachmentChipLabel 惯例）。 */
export function mentionChipLabel(path: string): string {
  const basename = path.split('/').at(-1) ?? path
  return `[file: ${basename}]`
}
