import { describe, expect, it } from 'vitest'

import {
  mentionChipLabel,
  mentionFileCandidates,
  mentionQueryAt,
  replaceMentionToken,
} from '../composer-mention'

describe('composer mention (W-05 @-picker)', () => {
  it('光标在末尾 + @ 在 token 边界才触发', () => {
    expect(mentionQueryAt('@src', 4)).toEqual({ query: 'src' })
    expect(mentionQueryAt('see @src', 8)).toEqual({ query: 'src' })
    expect(mentionQueryAt('see @src', 5)).toBeUndefined() // 光标不在末尾
    expect(mentionQueryAt('a@src', 5)).toBeUndefined() // 非 token 边界
    expect(mentionQueryAt('plain text', 10)).toBeUndefined()
  })

  it('文件候选：大小写不敏感前缀匹配 + 50 上限', () => {
    const files = ['Src/index.ts', 'src/app/main.tsx', 'README.md']
    expect(mentionFileCandidates('src', files).map((entry) => entry.path)).toEqual([
      'Src/index.ts',
      'src/app/main.tsx',
    ])
    expect(mentionFileCandidates('SRC', files).length).toBe(2)
    const many = Array.from({ length: 60 }, (_, index) => `f${index}.ts`)
    expect(mentionFileCandidates('f', many).length).toBe(50)
  })

  it('replaceMentionToken 删除 @query token；chip 取 basename', () => {
    expect(replaceMentionToken('see @src/ma', 'src/ma')).toBe('see ')
    expect(replaceMentionToken('@index', 'index')).toBe('')
    expect(mentionChipLabel('src/app/main.tsx')).toBe('[file: main.tsx]')
  })
})
