import { describe, expect, it } from 'vitest'

import { parseUnifiedDiff } from './DiffView'

describe('parseUnifiedDiff', () => {
  it('上下文行双行号同文推进', () => {
    const rows = parseUnifiedDiff(['@@ -1,2 +1,2 @@', ' a', ' b'].join('\n'))
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'ctx', 'ctx'])
    expect(rows[1]).toMatchObject({ kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' })
    expect(rows[2]).toMatchObject({ kind: 'ctx', oldNo: 2, newNo: 2, text: 'b' })
  })

  it('变更块先全量删行再全量增行（VS Code 式分组）', () => {
    const rows = parseUnifiedDiff(
      ['@@ -1,3 +1,2 @@', '-old1', '-old2', '-old3', '+new1', '+new2'].join('\n'),
    )
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'del', 'add', 'del', 'add', 'del'])
    expect(rows[1]).toMatchObject({ kind: 'del', oldNo: 1, text: 'old1' })
    expect(rows[2]).toMatchObject({ kind: 'add', newNo: 1, text: 'new1' })
    expect(rows[3]).toMatchObject({ kind: 'del', oldNo: 2, text: 'old2' })
    expect(rows[4]).toMatchObject({ kind: 'add', newNo: 2, text: 'new2' })
    // 多出的删行无配对：只有旧行号、无行内高亮。
    expect(rows[5]).toMatchObject({ kind: 'del', oldNo: 3, text: 'old3' })
    expect(rows[5]?.newNo).toBeUndefined()
    expect(rows[5]?.segments).toBeUndefined()
  })

  it('配对删/增行按公共前后缀裁剪出行内差异段', () => {
    const rows = parseUnifiedDiff(
      ['@@ -1,1 +1,1 @@', '-await Promise.all([first, second])', '+await first'].join('\n'),
    )
    expect(rows[1]?.segments).toEqual([
      { text: 'await ', changed: false },
      { text: 'Promise.all([first, second])', changed: true },
    ])
    expect(rows[2]?.segments).toEqual([
      { text: 'await ', changed: false },
      { text: 'first', changed: true },
    ])
  })

  it('中文注释的前后缀裁剪与完全重写（整行标 changed）', () => {
    const rows = parseUnifiedDiff(
      [
        '@@ -1,2 +1,2 @@',
        '-// 队首之外被决策：不发 resolved。',
        '+// 队首被决策：不发 resolved。',
        '-aaa',
        '+bbb',
      ].join('\n'),
    )
    expect(rows[1]?.segments).toEqual([
      { text: '// 队首', changed: false },
      { text: '之外', changed: true },
      { text: '被决策：不发 resolved。', changed: false },
    ])
    // 前后缀裁剪后新增行的差异段为空：只有未标 changed 的两段。
    expect(rows[2]?.segments).toEqual([
      { text: '// 队首', changed: false },
      { text: '被决策：不发 resolved。', changed: false },
    ])
    expect(rows[3]?.segments).toEqual([{ text: 'aaa', changed: true }])
    expect(rows[4]?.segments).toEqual([{ text: 'bbb', changed: true }])
  })

  it('纯新增段只有新行号（新建文件场景）', () => {
    const rows = parseUnifiedDiff(['@@ -0,0 +1,3 @@', '+a', '+', '+b'].join('\n'))
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'add', 'add', 'add'])
    expect(rows[1]).toMatchObject({ kind: 'add', newNo: 1, text: 'a' })
    expect(rows[1]?.oldNo).toBeUndefined()
    expect(rows[2]).toMatchObject({ kind: 'add', newNo: 2, text: '' })
    expect(rows[3]).toMatchObject({ kind: 'add', newNo: 3, text: 'b' })
  })

  it('多 hunk 行号各自从头计；文件头与 no-newline 说明被识别', () => {
    const rows = parseUnifiedDiff(
      [
        '--- a/f.ts',
        '+++ b/f.ts',
        '@@ -1,1 +1,1 @@',
        '-x',
        '+y',
        '@@ -10,1 +10,1 @@',
        ' ctx',
        '\\ No newline at end of file',
      ].join('\n'),
    )
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'del', 'add', 'hunk', 'ctx', 'meta'])
    expect(rows[1]).toMatchObject({ kind: 'del', oldNo: 1, text: 'x' })
    expect(rows[2]).toMatchObject({ kind: 'add', newNo: 1, text: 'y' })
    expect(rows[4]).toMatchObject({ kind: 'ctx', oldNo: 10, newNo: 10, text: 'ctx' })
    expect(rows[5]?.text).toBe('\\ No newline at end of file')
  })

  it('上下文空串按上下文处理（两侧行号都推进）', () => {
    const rows = parseUnifiedDiff(['@@ -3,2 +3,2 @@', '-a', '+b', '', '+c'].join('\n'))
    expect(rows.map((row) => row.kind)).toEqual(['hunk', 'del', 'add', 'ctx', 'add'])
    // 空串上下文：旧 4、新 4；其后新增行新 5。
    expect(rows[3]).toMatchObject({ kind: 'ctx', oldNo: 4, newNo: 4 })
    expect(rows[4]).toMatchObject({ kind: 'add', newNo: 5 })
  })
})
