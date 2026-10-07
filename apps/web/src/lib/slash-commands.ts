/**
 * W-05 slash 命令（web 本地表）：对齐 TUI「slash 执行是客户端行为」的语义——
 * server 没有 slash 概念，`/foo` 原样出站会被当用户消息起 turn，因此 Enter
 * 必须本地处理。注册表只收 web 真实可执行的动作，不放占位。
 */
import { currentLocale, translate } from './i18n'

export interface WebSlashCommand {
  name: string
  description: string
  aliases?: readonly string[]
  run(context: WebSlashContext): void | Promise<void>
}

export interface WebSlashContext {
  /** 当前是否有活动会话（多数命令的前置）。 */
  hasActiveSession: boolean
  interrupt(): void
  endSession(): void
  /** 就地提示（不发消息）。 */
  notice(text: string): void
}

/** 内置命令表：available 在运行期按 context 判定（如需会话的命令）。 */
export const WEB_SLASH_COMMANDS: readonly WebSlashCommand[] = [
  {
    name: 'interrupt',
    description: translate(currentLocale(), 'chat.slashInterrupt'),
    run: ({ hasActiveSession, interrupt, notice }) => {
      if (!hasActiveSession) return notice(translate(currentLocale(), 'chat.slashNoSession'))
      interrupt()
    },
  },
  {
    name: 'end',
    description: translate(currentLocale(), 'chat.slashEnd'),
    aliases: ['exit'],
    run: ({ hasActiveSession, endSession, notice }) => {
      if (!hasActiveSession) return notice(translate(currentLocale(), 'chat.slashNoSession'))
      endSession()
    },
  },
  {
    name: 'help',
    description: translate(currentLocale(), 'chat.slashHelp'),
    run: ({ notice }) =>
      notice(
        `Available commands: ${WEB_SLASH_COMMANDS.map((command) => `/${command.name}`).join(' · ')} (type / to trigger completion)`,
      ),
  },
]

/** 输入形如 `/xxx`（无空白）时返回 suggestion 查询（对齐 TUI slashSuggestions）。 */
export function slashQueryAt(value: string): string | undefined {
  if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) return undefined
  return value.slice(1)
}

/** 前缀匹配 name + aliases，按名称排序（对齐 TUI 建议序惯例）。 */
export function slashCandidates(
  query: string,
  commands: readonly WebSlashCommand[] = WEB_SLASH_COMMANDS,
): WebSlashCommand[] {
  const q = query.toLowerCase()
  return commands
    .filter(
      (command) =>
        command.name.toLowerCase().startsWith(q) ||
        (command.aliases?.some((alias) => alias.toLowerCase().startsWith(q)) ?? false),
    )
    .toSorted((left, right) => left.name.localeCompare(right.name))
}
