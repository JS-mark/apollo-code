import { describe, expect, it } from 'vitest'

import { createAskUserInteraction } from '../ask-interaction'
import { AskPromptController } from '../contracts'

const request = {
  question: '用哪个方案？',
  options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
}

describe('createAskUserInteraction（AskUserQuestion 的宿主交互面）', () => {
  it('tui 模式：进共享提问队列，decide 回填选中 label', async () => {
    const prompts = new AskPromptController()
    const ask = createAskUserInteraction({ prompts, mode: 'tui' })
    const pending = ask(request)
    await Promise.resolve()
    expect(prompts.requests()).toHaveLength(1)
    const id = prompts.requests()[0]!.id
    prompts.decide(id, '方案 B')
    await expect(pending).resolves.toBe('方案 B')
  })

  it('line 模式：数字选择 / label 原文 / 回车跳过', async () => {
    const prompts: AskPromptController[] = []
    const lines: string[] = []
    const byNumber = createAskUserInteraction({
      prompts: prompts[0] ?? new AskPromptController(),
      mode: 'line',
      linePrompt: async (question) => {
        lines.push(question)
        return '2'
      },
    })
    await expect(byNumber(request)).resolves.toBe('方案 B')
    expect(lines[0]).toContain('1) 方案 A')
    expect(lines[0]).toContain('2) 方案 B')

    const byLabel = createAskUserInteraction({
      prompts: new AskPromptController(),
      mode: 'line',
      linePrompt: async () => '方案 A',
    })
    await expect(byLabel(request)).resolves.toBe('方案 A')

    const skipped = createAskUserInteraction({
      prompts: new AskPromptController(),
      mode: 'line',
      linePrompt: async () => '',
    })
    await expect(skipped(request)).resolves.toBeUndefined()
  })

  it('none 模式：抛错（工具侧降级为「交互不可用」）', async () => {
    const ask = createAskUserInteraction({ prompts: new AskPromptController(), mode: 'none' })
    await expect(ask(request)).rejects.toThrow('unavailable')
  })
})
