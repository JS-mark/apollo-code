'use client'

import { Fragment, useMemo } from 'react'

/** 行内字级片段：changed=true 的段落在配对删/增行中加深底色（VS Code 式 intra-line 高亮）。 */
interface DiffSegment {
  text: string
  changed: boolean
}

/**
 * 一行 inline 渲染结果：ctx=上下文（双行号同文）；del=删除行（只有旧行号）；
 * add=新增行（只有新行号）；hunk=@@ 分隔；meta=\ No newline 之类的说明行。
 */
interface DiffRow {
  kind: 'ctx' | 'del' | 'add' | 'hunk' | 'meta'
  oldNo?: number
  newNo?: number
  text?: string
  segments?: DiffSegment[]
}

/** 公共前缀 + 公共后缀裁剪，得到配对删/增行的字级差异段（中间不同段标 changed）。 */
function inlineSegments(
  delText: string,
  addText: string,
): { del: DiffSegment[]; add: DiffSegment[] } {
  let prefix = 0
  const limit = Math.min(delText.length, addText.length)
  while (prefix < limit && delText[prefix] === addText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < limit - prefix &&
    delText[delText.length - 1 - suffix] === addText[addText.length - 1 - suffix]
  )
    suffix++
  const build = (text: string): DiffSegment[] => {
    const head = text.slice(0, prefix)
    const mid = text.slice(prefix, text.length - suffix)
    const tail = text.slice(text.length - suffix)
    const segments: DiffSegment[] = []
    if (head !== '') segments.push({ text: head, changed: false })
    if (mid !== '') segments.push({ text: mid, changed: true })
    if (tail !== '') segments.push({ text: tail, changed: false })
    return segments
  }
  return { del: build(delText), add: build(addText) }
}

/**
 * unified diff → VS Code 式 inline 行序列：每个变更块先全量删行再全量增行，
 * 块内第 i 条删与第 i 条增配对计算行内高亮；上下文行打断成块。
 */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let dels: { no: number; text: string }[] = []
  let adds: { no: number; text: string }[] = []
  const flush = () => {
    const len = Math.max(dels.length, adds.length)
    for (let i = 0; i < len; i++) {
      const del = dels[i]
      const add = adds[i]
      if (del && add) {
        const segments = inlineSegments(del.text, add.text)
        rows.push({ kind: 'del', oldNo: del.no, text: del.text, segments: segments.del })
        rows.push({ kind: 'add', newNo: add.no, text: add.text, segments: segments.add })
      } else if (del) {
        rows.push({ kind: 'del', oldNo: del.no, text: del.text })
      } else if (add) {
        rows.push({ kind: 'add', newNo: add.no, text: add.text })
      }
    }
    dels = []
    adds = []
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('@@')) {
      flush()
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (match && match[1] !== undefined && match[2] !== undefined) {
        oldNo = Number(match[1])
        newNo = Number(match[2])
      }
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('-')) {
      dels.push({ no: oldNo++, text: line.slice(1) })
      continue
    }
    if (line.startsWith('+')) {
      adds.push({ no: newNo++, text: line.slice(1) })
      continue
    }
    if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line })
      continue
    }
    // 上下文行（' ' 前缀；服务端产出的空串也按上下文算）。
    flush()
    rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
  }
  flush()
  return rows
}

/** 大 diff 首屏渲染上限（行数），其余以计数收口（W-08 虚拟化约定的延续）。 */
const DIFF_RENDER_MAX_ROWS = 2000

/**
 * VS Code 式 inline diff 视图：文件变更侧栏 / 变更页 / 工作台 git diff 共用。
 * 布局 = 左缘色条 | 旧行号 | 新行号 | 代码列；删行整行红、增行整行绿，
 * 配对删增行的差异片段再加深一档。纯展示组件，diff 字符串由调用方拉取。
 */
export function DiffView({ diff }: { diff: string }) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff])
  const visible = rows.slice(0, DIFF_RENDER_MAX_ROWS)
  const hidden = rows.length - visible.length
  return (
    <>
      <div className="diff-uni">
        {visible.map((row, index) => {
          if (row.kind === 'hunk' || row.kind === 'meta')
            return (
              <div key={index} className={row.kind === 'hunk' ? 'diff-hunk' : 'diff-meta'}>
                {row.text}
              </div>
            )
          const mode = row.kind === 'del' ? 'del' : row.kind === 'add' ? 'add' : 'ctx'
          return (
            <Fragment key={index}>
              <div className={`diff-bar ${mode}`} />
              <div className={`diff-gutter ${mode}`}>{row.oldNo ?? ''}</div>
              <div className={`diff-gutter ${mode}`}>{row.newNo ?? ''}</div>
              <div className={`diff-code ${mode}`}>
                {row.segments !== undefined
                  ? row.segments.map((segment, segIndex) =>
                      segment.changed ? (
                        <span key={segIndex} className="diff-hl">
                          {segment.text}
                        </span>
                      ) : (
                        segment.text
                      ),
                    )
                  : row.text}
              </div>
            </Fragment>
          )
        })}
      </div>
      {hidden > 0 ? (
        <div className="diff-more">
          已省略其余 {hidden} 行（文件过大，可在变更页查看全量净效果）
        </div>
      ) : null}
    </>
  )
}
