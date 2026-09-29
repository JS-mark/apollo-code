import type { ToolContext, ToolUiPort } from '@volund/tool-kit'
import { describe, expect, it } from 'vitest'

import { createAskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME } from '../ask-user'

type ChoiceFn = NonNullable<ToolUiPort['requestChoice']>

function contextWith(ui: Partial<ToolUiPort>): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    session: { id: 'session-1', cwd: '/repo', turnId: 'turn-1' },
    native: { execute: async () => '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ui: { requestInput: async () => '', ...ui },
  }
}

async function invoke(
  input: unknown,
  context: ToolContext,
): Promise<{ text: string; isError?: boolean }> {
  const result = await createAskUserQuestionTool().invoke(input, context)
  const part = result.content[0] as { type: string; text: string } | undefined
  return { text: part?.text ?? '', ...(result.isError === true ? { isError: true } : {}) }
}

const goodInput = {
  question: '用哪个方案？',
  options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
}

describe('createAskUserQuestionTool', () => {
  it('schema：question + 2..6 个带 label 的选项；免审批', () => {
    const tool = createAskUserQuestionTool()
    expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME)
    expect(tool.permissionSpec(goodInput as never)).toEqual({})
    const schema = tool.inputSchema as {
      required: string[]
      properties: Record<string, { type: string; maxItems?: number }>
    }
    expect(schema.required).toEqual(['question', 'options'])
    expect(schema.properties.question?.type).toBe('string')
    expect(schema.properties.options?.maxItems).toBe(6)
  })

  it('畸形入参（缺问题/选项不足）→ isError 文本', async () => {
    const result = await invoke({ question: '', options: [{ label: 'a' }] }, contextWith({}))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('at least 2 options')
  })

  it('宿主未接线 requestChoice（旧 fakes/无交互面）→ isError 交互不可用', async () => {
    const result = await invoke(goodInput, contextWith({}))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unavailable')
  })

  it('宿主抛错（如非交互模式）→ 同样降级为 isError 交互不可用', async () => {
    const requestChoice: ChoiceFn = async () => {
      throw new Error('user interaction is unavailable in non-interactive mode')
    }
    const result = await invoke(goodInput, contextWith({ requestChoice }))
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unavailable')
  })

  it('通道回填选中 label；非法值/undefined = 未作答', async () => {
    const picked: ChoiceFn = async () => '方案 B'
    const ok = await invoke(goodInput, contextWith({ requestChoice: picked }))
    expect(ok.text).toBe('User selected: "方案 B"')

    const dismissed: ChoiceFn = async () => undefined
    const skipped = await invoke(goodInput, contextWith({ requestChoice: dismissed }))
    expect(skipped.text).toContain('dismissed')

    const bogus: ChoiceFn = async () => '不存在的选项'
    const invalid = await invoke(goodInput, contextWith({ requestChoice: bogus }))
    expect(invalid.text).toContain('dismissed')
  })

  it('提问原文与选项原样透传给宿主通道', async () => {
    let seen: { question: string; options: unknown } | undefined
    const requestChoice: ChoiceFn = async (request) => {
      seen = { question: request.question, options: request.options }
      return request.options[0]!.label
    }
    await invoke(goodInput, contextWith({ requestChoice }))
    expect(seen).toEqual({
      question: '用哪个方案？',
      options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
    })
  })
})
