import { describe, expect, it } from 'vitest'

import {
  normalizeSpecEscapes,
  parsePermissionDisplaySpec,
  summarizePermissionSpec,
} from '../permission-spec'

describe('normalizeSpecEscapes（display.spec 的 \\u{...} 转义归一）', () => {
  it('\\u{HEX} 转成合法 JSON 转义（BMP 4 位 / 超 BMP 代理对）', () => {
    // normalize 把 \\u{HEX} 改写为合法 JSON 转义 \\uXXXX（>FFFF 拆代理对），不解析 JSON。
    expect(normalizeSpecEscapes(String.raw`a\u{000A}b`)).toBe(String.raw`a\u000Ab`)
    expect(normalizeSpecEscapes(String.raw`x\u{0041}`)).toBe(String.raw`x\u0041`)
    expect(normalizeSpecEscapes(String.raw`\u{1F600}`)).toBe(String.raw`\ud83d\ude00`)
    // 非法序列原样保留（不猜测）
    expect(normalizeSpecEscapes(String.raw`\u{ZZZ}`)).toBe(String.raw`\u{ZZZ}`)
  })
})

describe('summarizePermissionSpec（能力行口径对齐 TUI）', () => {
  it('fs/bash/net/env/custom 全能力行', () => {
    const lines = summarizePermissionSpec({
      fs: { read: ['/a'], write: ['/b', '/c'] },
      bash: { command: 'ls -la' },
      net: { method: 'POST', url: 'https://x' },
      env: { read: ['A', 'B'] },
      custom: { foo: 1 },
    })
    expect(lines).toEqual([
      { kind: 'read', label: '读取', value: '/a' },
      { kind: 'write', label: '写入', value: '/b\n/c' },
      { kind: 'run', label: '运行', value: '$ ls -la' },
      { kind: 'net', label: '网络', value: 'POST https://x' },
      { kind: 'env', label: '环境', value: 'A, B' },
      { kind: 'custom', label: '自定义', value: 'foo 1' },
    ])
  })

  it('非对象 spec → 空行（调用方回退原文）', () => {
    expect(summarizePermissionSpec('bash')).toEqual([])
    expect(summarizePermissionSpec(null)).toEqual([])
    expect(summarizePermissionSpec([])).toEqual([])
  })

  it('非字符串数组字段被跳过', () => {
    expect(summarizePermissionSpec({ fs: { read: [1, 2] as unknown as string[] } })).toEqual([])
  })
})

describe('parsePermissionDisplaySpec', () => {
  it('可审批的合法 JSON：能力行 + 美化 JSON 双出', () => {
    const view = parsePermissionDisplaySpec(true, '{"fs":{"write":["/tmp/x.ts"]}}')
    expect(view.lines).toEqual([{ kind: 'write', label: '写入', value: '/tmp/x.ts' }])
    expect(view.pretty).toBe(JSON.stringify({ fs: { write: ['/tmp/x.ts'] } }, null, 2))
  })

  it('多行命令经 \\u{000A} 归一还原（run 行值带真换行）', () => {
    const view = parsePermissionDisplaySpec(
      true,
      String.raw`{"bash":{"command":"echo a\u{000A}echo b"}}`,
    )
    expect(view.lines).toEqual([{ kind: 'run', label: '运行', value: '$ echo a\necho b' }])
  })

  it('不可审批（approvable=false）恒为空面，不碰 spec 文本', () => {
    const view = parsePermissionDisplaySpec(false, '{"fs":{"write":["/tmp/x"]}}')
    expect(view).toEqual({ lines: [] })
  })

  it('解析失败（非法 JSON / 占位文案）：空能力行且无美化，UI 回退原文', () => {
    expect(
      parsePermissionDisplaySpec(true, '[permission details unavailable - deny only]'),
    ).toEqual({
      lines: [],
    })
    expect(parsePermissionDisplaySpec(true, '{oops')).toEqual({ lines: [] })
  })
})
