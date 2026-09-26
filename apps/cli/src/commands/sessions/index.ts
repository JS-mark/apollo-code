import type { CliIo, CliResult, CommandDefinition } from '../../shared/cli-types'

function failure(exitCode: number, message: string): CliResult {
  return { exitCode, stdout: '', stderr: message }
}

/**
 * `volund sessions`：会话档案的轻量管理面（list / delete）。
 * 与 `volund history` 的区别：history 是只读检视 + 全量清理；这里对准单会话
 * 删除（Web/移动端/TUI /sessions 共用同一条 controller.delete 链路——活动会话
 * 先 end 再删档并冷启动）。
 */
export function createSessionsCommand(io: CliIo): CommandDefinition {
  return {
    name: 'sessions',
    async run({ args, ports }) {
      const session = ports.session
      const action = args._[1] ?? 'list'
      try {
        if (action === 'list') {
          if (!session.list) return failure(2, 'session listing is not connected')
          const sessions = await session.list()
          if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(sessions)}\n`, stderr: '' }
          return {
            exitCode: 0,
            stdout: sessions.length
              ? `${sessions
                  .map((entry) => `${entry.id}\t${entry.updatedAt}\t${entry.cwd}\t${entry.title}`)
                  .join('\n')}\n`
              : 'No sessions.\n',
            stderr: '',
          }
        }
        if (action === 'delete') {
          if (!session.delete) return failure(2, 'session deletion is not connected')
          const raw = args._[2]
          if (!raw) return failure(2, 'sessions delete requires a session id (or unique prefix)')
          // 前缀匹配放宽手输成本；list 未接线时把原始 id 直接交给 controller 校验。
          const matches = (await session.list?.().catch(() => undefined))?.filter((entry) =>
            entry.id.startsWith(raw),
          )
          const target =
            matches === undefined
              ? { id: raw, title: raw }
              : (matches.find((entry) => entry.id === raw) ??
                (matches.length === 1 ? matches[0] : undefined))
          if (!target) {
            if (matches !== undefined && matches.length > 1)
              return failure(
                2,
                `Ambiguous session prefix: ${matches.map((entry) => entry.id).join(', ')}`,
              )
            return failure(3, `Session not found: ${raw}`)
          }
          // 与 history clear / memory delete 同一确认契约：非交互必须显式 --yes。
          if (args.yes !== true) {
            if (args.json || args.noTui || !io.isInteractiveTerminal?.() || !io.confirm)
              return failure(2, 'sessions delete requires --yes outside an interactive terminal')
            if (!(await io.confirm(`Delete session "${target.title}" (${target.id})?`)))
              return failure(2, 'Session was not deleted')
          }
          const result = await session.delete(target.id)
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify({
                  deleted: target.id,
                  ...(result.next ? { next: result.next } : {}),
                })}\n`
              : result.next
                ? `Deleted session ${target.id} (was active; new session: ${result.next})\n`
                : `Deleted session ${target.id}\n`,
            stderr: '',
          }
        }
        return failure(2, `Unknown sessions action: ${action}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code =
          error !== null && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : undefined
        if (code === 'session_turn_in_progress') return failure(4, message)
        return failure(
          code === 'session_not_found' || code === 'session_id_invalid' ? 3 : 1,
          message,
        )
      }
    },
  }
}
