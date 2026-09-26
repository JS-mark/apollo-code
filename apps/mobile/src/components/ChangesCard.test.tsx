import { describe, expect, it } from 'vitest'

import { diffLineClass } from './ChangesCard'

/** 消息流变更卡片的行内 diff 渲染：unified diff 行分类（meta 行不进渲染）。 */
describe('diffLineClass（变更卡片行内 diff 行分类）', () => {
  it('classifies hunk/add/del/ctx and filters file headers as meta', () => {
    expect(diffLineClass('@@ -1,2 +1,2 @@')).toBe('hunk')
    expect(diffLineClass('+added line')).toBe('add')
    expect(diffLineClass('-removed line')).toBe('del')
    expect(diffLineClass(' context line')).toBe('ctx')
    // +++/--- 文件头是 meta（不计入增删行）。
    expect(diffLineClass('+++ b/a.ts')).toBe('meta')
    expect(diffLineClass('--- a/a.ts')).toBe('meta')
  })

  it('keeps leading +-content inside context lines as ctx', () => {
    expect(diffLineClass(' +- not a marker')).toBe('ctx')
    expect(diffLineClass('')).toBe('ctx')
  })
})
