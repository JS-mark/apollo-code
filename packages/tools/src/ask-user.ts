/**
 * AskUserQuestion：模型向用户发起结构化单选题（问题 + 2..6 个带说明的选项）。
 *
 * 工具本体零依赖：交互全走 ToolContext.ui 的可选 `requestChoice` 通道
 * （tool-kit 的 ToolUiPort 接缝）——宿主决定交互面（TUI/Web 共享提问队列、
 * 终端数字问答），工具只关心「拿到选中 label / 未作答 / 通道不可用」。
 * 宿主接缝见 app-runtime 的 createAskUserInteraction（生产装配）。
 *
 * 免审批（permissionSpec => {}）：提问本身就是交互，不需要二次授权。
 */
import type { AskChoiceDismissal, Tool, ToolContext, ToolResult } from '@volund/tool-kit'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

const MAX_QUESTION_LENGTH = 2000
const MAX_OPTIONS = 6
const MAX_LABEL_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 500

const UNAVAILABLE_RESULT =
  'User interaction is unavailable in this mode ' +
  '(no interactive surface is wired). Proceed with the best default option and note the ' +
  'assumption in your answer.'

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
    meta: { durationMs: 0, costImpact: 'safe' },
  }
}

export function createAskUserQuestionTool(): Tool {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description:
      'Ask the user a multiple-choice question and wait for their answer. ' +
      'Use this when you need the user to make a decision or pick between concrete options ' +
      '(e.g. approach, scope, trade-offs). Provide 2-6 mutually exclusive options, each with a ' +
      'short description of its consequence. The user may also dismiss the question without ' +
      'answering — then proceed with what you consider the best default.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'options'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_LENGTH },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label'],
            properties: {
              label: { type: 'string', minLength: 1, maxLength: MAX_LABEL_LENGTH },
              description: { type: 'string', maxLength: MAX_DESCRIPTION_LENGTH },
            },
          },
        },
      },
    },
    permissionSpec: () => ({}),
    async invoke(value, context: ToolContext) {
      const input = value as { question?: unknown; options?: unknown }
      const question = typeof input.question === 'string' ? input.question.trim() : ''
      const rawOptions = Array.isArray(input.options) ? input.options : []
      const options: { label: string; description?: string }[] = []
      for (const raw of rawOptions) {
        if (!raw || typeof raw !== 'object') continue
        const record = raw as { label?: unknown; description?: unknown }
        if (typeof record.label !== 'string' || !record.label.trim()) continue
        options.push({
          label: record.label.trim(),
          ...(typeof record.description === 'string' && record.description.trim()
            ? { description: record.description.trim() }
            : {}),
        })
      }
      if (!question || options.length < 2)
        return textResult('AskUserQuestion requires a question and at least 2 options.', true)
      const requestChoice = context.ui.requestChoice
      if (!requestChoice) return textResult(UNAVAILABLE_RESULT, true)
      let answer: string | AskChoiceDismissal | undefined
      try {
        answer = await requestChoice({ question, options })
      } catch {
        // 宿主明确拒绝（如非交互模式）：与「未接线」同语义，模型自选默认继续。
        return textResult(UNAVAILABLE_RESULT, true)
      }
      if (answer !== undefined && typeof answer !== 'string') {
        if (answer.reason === 'timeout')
          return textResult(
            `ask_timeout: No one responded to the question before it was auto-closed; proceed with the best default and note the assumption.`,
          )
        return textResult('User dismissed the question without answering.')
      }
      if (answer === undefined || !options.some((option) => option.label === answer))
        return textResult('User dismissed the question without answering.')
      return textResult(`User selected: "${answer}"`)
    },
  }
}
