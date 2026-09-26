/**
 * volund-plugin-ask — 内置插件：AskUserQuestion 提问引导 system prompt。
 *
 * AskUserQuestion 工具本体在 packages/tools（免审批，交互走 ToolUiPort
 * 的 requestChoice 接缝），但没有指引时模型倾向用正文追问——用户明确
 * 要求「问我」时尤其如此。本插件经 prompt.contribute 往每会话 system
 * prompt 注入一段静态指引：需要用户在具体选项间拍板、或用户要求被提问
 * 时，一律走 AskUserQuestion 结构化提问。
 *
 * TS 单文件入口（strip-types 可擦子集：interface / 类型标注可用，enum /
 * namespace / 参数属性不支持）；`import type` 只取 SDK 类型，沙箱里零依赖。
 * 装载链路与其余内置插件一致：volund-sandbox --run-plugin + fd3 桥；dev 态宿主
 * 以 Node ≥ 22.6 strip-types 直接装载 index.ts，产物由 rolldown 编译成 .mjs 分发
 * （见 rolldown.config.mjs 与 plugins/README.md）。
 */
import type { VolundBridge } from '@volund/plugin-sdk'

const ASK_GUIDANCE = `## Asking the user questions
Use the AskUserQuestion tool — not prose — whenever the user asks you to ask them questions, and whenever their decision would change what you do next (approach, scope, trade-offs, naming, missing parameters). Send one focused question per call with 2-6 mutually exclusive options, each option describing its consequence, then wait for the answers before continuing. Reserve plain-text questions for genuinely open-ended matters with no enumerable options; when in doubt, offer your best candidates as options instead of an open question.`

export async function activate(volund: VolundBridge): Promise<void> {
  // 静态 fragment 进每会话 system prompt（id 自动加 plugin:volund-plugin-ask:
  // 命名空间；priority 600 = 插件缺省档，低于 skills 800 / builtin 1000）。
  await volund.prompt.contribute({
    id: 'ask-user-question',
    priority: 600,
    content: ASK_GUIDANCE,
  })
}
