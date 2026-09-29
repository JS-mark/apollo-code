import type { AskChoiceDismissal, ToolChoiceRequest } from '@volund/tool-kit'
/**
 * AskUserQuestion 的宿主交互面：把 ToolUiPort 的可选 `requestChoice` 通道
 * （tool-kit 接缝）接到本进程的共享提问队列。工具本体在 packages/tools
 * （零依赖，只认通道）；这里决定交互面：
 * - tui：进 AskPromptController 共享队列——TUI 选项卡与 Web/Mobile 问答卡
 *   任一端作答全端清卡（§22 W-07 同款多路分发）；
 * - line：终端数字问答（与权限链 linePermissionPrompt 同一接缝）；
 * - none：抛错——工具侧按「交互不可用」降级，模型自选默认继续。
 */
import { v7 as uuidv7 } from 'uuid'

import type { AskPromptController, PermissionInteractionMode } from './contracts'

export interface AskUserInteractionOptions {
  /** 共享提问队列（tui 模式；Web/Mobile 经 hub 视图帧作答）。 */
  readonly prompts: AskPromptController
  /** 本会话冻结的交互模式（createRunner 时取自权限快照，与权限卡同源）。 */
  readonly mode: PermissionInteractionMode
  /**
   * line 模式的行输入接缝（与权限链 linePermissionPrompt 同形）：question 文本
   * 已编排好「问题 + 编号选项 + 提示」；返回 undefined/空 = 用户放弃。
   */
  readonly linePrompt?: ((question: string) => Promise<string | undefined>) | undefined
}

/** 出站投影：剥掉 undefined 字段（exactOptionalPropertyTypes）。 */
function projectOptions(options: ToolChoiceRequest['options']): ToolChoiceRequest['options'] {
  return options.map((option) =>
    option.description === undefined
      ? { label: option.label }
      : { label: option.label, description: option.description },
  )
}

export function createAskUserInteraction(
  options: AskUserInteractionOptions,
): (request: ToolChoiceRequest) => Promise<string | AskChoiceDismissal | undefined> {
  return async (request) => {
    if (options.mode === 'none')
      throw new Error('user interaction is unavailable in non-interactive mode')
    if (options.mode === 'line') {
      const menu = request.options
        .map((option, index) => `${index + 1}) ${option.label}`)
        .join('\n')
      const answer = (
        await options.linePrompt?.(
          `${request.question}\n${menu}\n选择 1-${request.options.length}（回车跳过）: `,
        )
      )?.trim()
      if (!answer) return undefined
      const index = Number.parseInt(answer, 10)
      const picked =
        Number.isInteger(index) && index >= 1 && index <= request.options.length
          ? request.options[index - 1]
          : request.options.find((option) => option.label === answer)
      return picked?.label
    }
    const id = uuidv7()
    const answer = await options.prompts.request({
      id,
      question: request.question,
      options: projectOptions(request.options),
    })
    // 网关超时自动关闭（AskPromptController.decide 带 timeout 标记）：模型侧要能
    // 区分「用户主动跳过」与「无人应答超时」，故以结构化结果外露。
    return options.prompts.consumeTimedOut(id) ? { reason: 'timeout' } : answer
  }
}
