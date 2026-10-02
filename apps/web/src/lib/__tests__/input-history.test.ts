import { describe, expect, it } from 'vitest'

import {
  arrowDownNavigatesHistory,
  arrowUpOpensHistory,
  historyDown,
  historyUp,
  historyValue,
  initialInputHistory,
  pushHistory,
  resetHistoryNavigation,
} from '../input-history'

describe('input history (W-05)', () => {
  it('pushHistory 去相邻重复 + 截断上限', () => {
    let entries = pushHistory([], 'a')
    entries = pushHistory(entries, 'a')
    entries = pushHistory(entries, 'b')
    expect(entries).toEqual(['a', 'b'])
    for (let index = 0; index < 250; index++) entries = pushHistory(entries, `n${index}`)
    expect(entries.length).toBe(200)
    expect(entries.at(-1)).toBe('n249')
  })

  it('↑ 首次进历史存 draft、落最新一条；更旧；↓ 越界还原 draft', () => {
    let state: ReturnType<typeof initialInputHistory> = {
      ...initialInputHistory(),
      entries: ['one', 'two', 'three'],
    }
    state = historyUp(state, 'current draft')
    expect(state.index).toBe(2)
    expect(state.draftBefore).toBe('current draft')
    expect(historyValue(state)).toBe('three')
    state = historyUp(state, 'two')
    expect(historyValue(state)).toBe('two' as string | null)
    state = historyDown(state)
    expect(historyValue(state)).toBe('three' as string | null)
    state = historyDown(state)
    expect(state.index).toBe(-1)
    expect(historyValue(state)).toBe('current draft')
  })

  it('空历史 / 不在历史态时 ↓ 无操作；打字复位', () => {
    const empty = initialInputHistory()
    expect(historyUp(empty, 'x')).toBe(empty)
    expect(historyDown(empty)).toBe(empty)
    let state = historyUp({ ...empty, entries: ['a'] }, 'd')
    state = resetHistoryNavigation(state)
    expect(state.index).toBe(-1)
    expect(historyValue(state)).toBeNull()
  })

  it('caret 首行才 ↑ 翻历史；历史态内 caret 末行才 ↓', () => {
    expect(arrowUpOpensHistory('line1\nline2', 3)).toBe(true)
    // caret 已在第二行行首 → 不翻历史
    expect(arrowUpOpensHistory('line1\nline2', 6)).toBe(false)
    expect(arrowUpOpensHistory('single', 6)).toBe(true)
    const state = { ...initialInputHistory(), entries: ['a'], index: 0 }
    expect(arrowDownNavigatesHistory(state, 'a', 1)).toBe(true)
    expect(arrowDownNavigatesHistory(state, 'a\nb', 1)).toBe(false)
  })
})
