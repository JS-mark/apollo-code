/**
 * W-05 历史输入（纯函数）：把 TUI InputBox 的历史语义（:413-441）直译为
 * 可测状态机——首次 ↑ 存下当前 draft、从最新一条开始；↓ 越界还原 draft；
 * 任何打字复位历史态。持久化（localStorage per cwd）由 ChatPanel 负责。
 */

export interface InputHistoryState {
  /** 历史条目（旧→新）。 */
  entries: readonly string[]
  /** 当前浏览位置（entries 下标）；-1 = 不在历史浏览态。 */
  index: number
  /** 进入历史态之前的 draft（↓ 越界还原用）。 */
  draftBefore: string | undefined
}

export const INPUT_HISTORY_MAX = 200

export function initialInputHistory(): InputHistoryState {
  return { entries: [], index: -1, draftBefore: undefined }
}

/** 追加一条（去重相邻、截断上限）；返回新列表。 */
export function pushHistory(
  entries: readonly string[],
  input: string,
  max = INPUT_HISTORY_MAX,
): string[] {
  const value = input.trim()
  if (!value) return [...entries]
  if (entries.at(-1) === value) return [...entries]
  const next = [...entries, value]
  return next.length > max ? next.slice(next.length - max) : next
}

/** ↑：不在历史态时先存 draft、落到最新一条；已在则更旧。到头停住。 */
export function historyUp(state: InputHistoryState, currentDraft: string): InputHistoryState {
  if (state.entries.length === 0) return state
  if (state.index === -1)
    return {
      ...state,
      index: state.entries.length - 1,
      draftBefore: currentDraft,
    }
  return { ...state, index: Math.max(0, state.index - 1) }
}

/** ↓：在历史态内更新；越过最新一条则回到「还原 draft」态（draftBefore 保留供
 * historyValue 回显；打字时才由 resetHistoryNavigation 清掉）。 */
export function historyDown(state: InputHistoryState): InputHistoryState {
  if (state.index === -1) return state
  if (state.index >= state.entries.length - 1) return { ...state, index: -1 }
  return { ...state, index: state.index + 1 }
}

/** 当前应显示的输入值；不在历史态返回 null（保持原 draft）。 */
export function historyValue(state: InputHistoryState): string | null {
  if (state.index === -1) return state.draftBefore ?? null
  return state.entries[state.index] ?? state.draftBefore ?? ''
}

/** 打字/提交复位历史态（保留 entries）。 */
export function resetHistoryNavigation(state: InputHistoryState): InputHistoryState {
  return state.index === -1 && state.draftBefore === undefined
    ? state
    : { ...state, index: -1, draftBefore: undefined }
}

/**
 * ↑ 是否应触发历史：caret 在第一行（draft 首行内无换行分隔）且无弹层占用。
 * （多行 textarea 惯例：↑ 在首行才翻历史，其余位置保持光标移动。）
 */
export function arrowUpOpensHistory(draft: string, selectionStart: number): boolean {
  return !draft.slice(0, selectionStart).includes('\n')
}

/** ↓ 是否应触发历史（历史态内 + caret 在最后一行）。 */
export function arrowDownNavigatesHistory(
  state: InputHistoryState,
  draft: string,
  selectionStart: number,
): boolean {
  if (state.index === -1) return false
  return !draft.slice(selectionStart).includes('\n')
}
