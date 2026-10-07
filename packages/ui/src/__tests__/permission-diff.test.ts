import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { permissionDiffPreview } from '../permission-diff'

describe('permissionDiffPreview (权限卡 diff 预览)', () => {
  it('renders an Edit as del/add rows with context collapsed', () => {
    const rows = permissionDiffPreview(
      'Edit',
      { path: 'a.ts', old_string: 'before\nsame', new_string: 'after\nsame' },
      60,
    )
    expect(rows).toEqual([
      { tone: 'del', text: 'before' },
      { tone: 'add', text: 'after' },
    ])
  })

  it('returns nothing for a no-op edit', () => {
    expect(
      permissionDiffPreview('Edit', { path: 'a.ts', old_string: 'x', new_string: 'x' }, 60),
    ).toEqual([])
  })

  it('closes oversized Edit previews with a counted meta row', () => {
    const old = Array.from({ length: 30 }, (_, i) => `old${i}`).join('\n')
    const next = Array.from({ length: 30 }, (_, i) => `new${i}`).join('\n')
    const rows = permissionDiffPreview('Edit', { old_string: old, new_string: next }, 60)
    expect(rows.length).toBe(13)
    expect(rows.at(-1)).toEqual({ tone: 'meta', text: '… +30 −30 lines in total' })
    expect(rows.filter((row) => row.tone === 'del').length).toBe(12)
  })

  it('previews the head of a Write and notes the remainder', () => {
    const content = Array.from({ length: 9 }, (_, i) => `line${i}`).join('\n')
    const rows = permissionDiffPreview('Write', { path: 'new.ts', content }, 60)
    expect(rows[0]).toEqual({ tone: 'meta', text: 'New content: 9 lines (showing first 6)' })
    expect(rows[1]).toEqual({ tone: 'add', text: 'line0' })
    expect(rows.at(-1)).toEqual({ tone: 'meta', text: '… 3 more lines' })
  })

  it('labels an empty Write', () => {
    expect(permissionDiffPreview('Write', { path: 'e.txt', content: '' }, 60)).toEqual([
      { tone: 'meta', text: 'Writing an empty file' },
    ])
  })

  it('groups MultiEdit by path and totals the counts', () => {
    const rows = permissionDiffPreview(
      'MultiEdit',
      {
        edits: [
          { path: 'a.ts', old_string: 'one', new_string: '1' },
          { path: 'b.ts', old_string: 'two', new_string: '2\n2b' },
        ],
      },
      60,
    )
    expect(rows).toEqual([
      { tone: 'meta', text: 'a.ts' },
      { tone: 'del', text: 'one' },
      { tone: 'add', text: '1' },
      { tone: 'meta', text: 'b.ts' },
      { tone: 'del', text: 'two' },
      { tone: 'add', text: '2' },
      { tone: 'add', text: '2b' },
      { tone: 'meta', text: 'Total: +3 −2 lines' },
    ])
  })

  it('elides MultiEdit edits beyond the shown budget', () => {
    const edits = Array.from({ length: 6 }, (_, i) => ({
      path: `f${i}.ts`,
      old_string: `old${i}`,
      new_string: `new${i}`,
    }))
    const rows = permissionDiffPreview('MultiEdit', { edits }, 60)
    expect(rows.some((row) => row.text === '… remaining edits omitted')).toBe(true)
    expect(rows.some((row) => row.text === 'f5.ts')).toBe(false)
    expect(rows.at(-1)).toEqual({ tone: 'meta', text: 'Total: +6 −6 lines' })
  })

  it('escapes untrusted content instead of emitting raw control characters', () => {
    const rows = permissionDiffPreview(
      'Edit',
      { old_string: 'a', new_string: `evil\u0007tone` },
      60,
    )
    expect(rows).toEqual([
      { tone: 'del', text: 'a' },
      { tone: 'add', text: 'evil\\u{0007}tone' },
    ])
  })

  it('truncates long preview lines to the given width', () => {
    const rows = permissionDiffPreview('Edit', { old_string: 'a', new_string: 'x'.repeat(80) }, 30)
    expect(rows[0]).toEqual({ tone: 'del', text: 'a' })
    expect(rows[1]!.text.length).toBeLessThanOrEqual(30)
    expect(rows[1]!.text.endsWith('…')).toBe(true)
  })

  it('returns nothing for read-only tools and malformed input', () => {
    expect(permissionDiffPreview('Read', { path: 'a' }, 60)).toEqual([])
    expect(permissionDiffPreview('Edit', 'not-an-object', 60)).toEqual([])
    expect(permissionDiffPreview('Edit', { old_string: 1, new_string: 'x' }, 60)).toEqual([])
    expect(permissionDiffPreview('Write', { path: 'a' }, 60)).toEqual([])
    expect(permissionDiffPreview('MultiEdit', { edits: 'nope' }, 60)).toEqual([])
  })

  it('flags an Edit whose old_string no longer matches the current file (P5)', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'volund-perm-diff-'))
    await writeFile(resolve(dir, 'a.ts'), 'const value = 2\n')
    // 文件已改：模型手里的 old_string（value = 1）在当前盘面不存在。
    const rows = permissionDiffPreview(
      'Edit',
      { path: 'a.ts', old_string: 'const value = 1', new_string: 'const value = 3' },
      60,
      dir,
    )
    expect(rows[0]).toEqual({
      tone: 'meta',
      text: '⚠ The target file no longer contains this text (may have been modified externally)',
    })
    expect(rows).toContainEqual({ tone: 'del', text: 'const value = 1' })
  })

  it('counts occurrences for replace_all and warns on ambiguity without it', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'volund-perm-diff-'))
    await writeFile(resolve(dir, 'b.ts'), 'x = 1\nx = 1\nx = 1\n')
    // replace_all：明示真实处数。
    const all = permissionDiffPreview(
      'Edit',
      { path: 'b.ts', old_string: 'x = 1', new_string: 'x = 2', replace_all: true },
      60,
      dir,
    )
    expect(all).toContainEqual({ tone: 'meta', text: 'Will replace all 3 occurrences' })
    // 未指定 replace_all + 多处：执行将失败，批准前明示。
    const ambiguous = permissionDiffPreview(
      'Edit',
      { path: 'b.ts', old_string: 'x = 1', new_string: 'x = 2' },
      60,
      dir,
    )
    expect(ambiguous[0]).toEqual({
      tone: 'meta',
      text: '⚠ This text appears 3 times in the file; replace_all is not set, so the edit will fail',
    })
    // 单处匹配：不告警。
    await writeFile(resolve(dir, 'c.ts'), 'x = 1\n')
    const clean = permissionDiffPreview(
      'Edit',
      { path: 'c.ts', old_string: 'x = 1', new_string: 'x = 2' },
      60,
      dir,
    )
    expect(clean.every((row) => row.tone !== 'meta' || !row.text.startsWith('⚠'))).toBe(true)
  })

  it('shows the existing file size on a Write overwrite (P3/P5)', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'volund-perm-diff-'))
    await writeFile(resolve(dir, 'existing.ts'), 'x'.repeat(2048))
    const rows = permissionDiffPreview(
      'Write',
      { path: 'existing.ts', content: 'new content\n' },
      60,
      dir,
    )
    expect(rows[0]).toEqual({
      tone: 'meta',
      text: 'Will overwrite existing file existing.ts (currently 2.0 KB)',
    })
    // 新文件：无覆盖警告。
    const fresh = permissionDiffPreview('Write', { path: 'new.ts', content: 'hello\n' }, 60, dir)
    expect(fresh[0]!.text).toMatch(/^New content: 1 line/)
    expect(fresh.some((row) => row.text.includes('overwrite'))).toBe(false)
  })

  it('flags large Edit changes per §4.6 (>100 lines)', () => {
    const old = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n')
    const next = Array.from({ length: 120 }, (_, i) => `new ${i}`).join('\n')
    const rows = permissionDiffPreview('Edit', { old_string: old, new_string: next }, 60)
    expect(rows[0]).toEqual({
      tone: 'meta',
      text: '⚠ Large change: 240 lines in total — review before approving',
    })
    // 99 行改动不触发。
    const small = Array.from({ length: 50 }, (_, i) => `o${i}`).join('\n')
    const smallNext = Array.from({ length: 50 }, (_, i) => `n${i}`).join('\n')
    const rowsSmall = permissionDiffPreview(
      'Edit',
      { old_string: small, new_string: smallNext },
      60,
    )
    expect(rowsSmall.every((row) => !row.text.includes('Large change'))).toBe(true)
  })

  it('flags large MultiEdit batches per §4.6', () => {
    const edits = Array.from({ length: 60 }, (_, i) => ({
      path: `f${i}.ts`,
      old_string: `old${i}`,
      new_string: `new${i}`,
    }))
    const rows = permissionDiffPreview('MultiEdit', { edits }, 60)
    expect(rows[0]).toEqual({
      tone: 'meta',
      text: '⚠ Large change: 120 lines in total — review before approving',
    })
  })
})
