/**
 * MCP fatigue 防护 S0（§11.3.9 / 2026-09-30 design §S1）：per-MCP 交互权限弹窗
 * 限速。恶意/失控 server 可批量暴露 tool，每个调用都弹审批卡 → 疲劳轰炸用户
 * 「点 allow」。守卫在 prompt 链上游计数：同 server 60 秒滑动窗口内交互请求超
 * `max_prompts_per_minute`（user/project 取 min，缺省 10）→ 直接 deny，不进
 * 共享审批队列。配置读取失败 fail-open 用缺省值，绝不阻断审批链。
 */
import type { McpServerConfig } from './mcp-domain'

export interface McpFatigueGuard {
  /**
   * 一次交互权限请求到达：记录并在超限时拒绝。
   * 返回 undefined = 放行（进审批队列）；返回值 = 直接以该决策拒绝。
   */
  check(serverName: string): { kind: 'deny'; reason: 'fatigue' } | undefined
}

const WINDOW_MS = 60_000

export function createMcpFatigueGuard(options: {
  /** 活动会话 cwd（解析 user + project 两层 mcp.toml 用）。 */
  cwd: () => string
  volundHome: () => string
  /** MCP server 配置加载（复用 loadMcpServerConfigs；实现方自带缓存亦可）。 */
  loadConfigs: (input: { volundHome: string; cwd: string }) => Promise<McpServerConfig[]>
  now?: () => number
  /** 超限采样（telemetry securityEvent 通道；实现方自行脱敏）。 */
  onLimited?: (serverName: string) => void
  /** 限速值解析/加载异常时调用（警告通道），行为上 fail-open。 */
  onWarning?: (message: string) => void
}): McpFatigueGuard {
  const now = options.now ?? Date.now
  /** server → 60s 窗口内的请求时间戳。 */
  const windows = new Map<string, number[]>()
  let cachedLimits: Map<string, number> | undefined
  let cachedAt = 0
  const CACHE_TTL_MS = 30_000

  const limitFor = (serverName: string): number => {
    const instant = now()
    if (cachedLimits === undefined || instant - cachedAt > CACHE_TTL_MS) {
      cachedAt = instant
      cachedLimits = new Map()
      void options
        .loadConfigs({ volundHome: options.volundHome(), cwd: options.cwd() })
        .then((configs) => {
          // user/project 同名取 min：clone 来的仓库只能收紧、不能放宽轰炸上限。
          const merged = new Map<string, number>()
          for (const config of configs) {
            const existing = merged.get(config.name)
            merged.set(
              config.name,
              existing === undefined
                ? config.maxPromptsPerMinute
                : Math.min(existing, config.maxPromptsPerMinute),
            )
          }
          cachedLimits = merged
        })
        .catch((error: unknown) => {
          options.onWarning?.(
            `mcp fatigue: config load failed, using defaults: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        })
    }
    return cachedLimits?.get(serverName) ?? 10
  }

  return {
    check(serverName) {
      const limit = limitFor(serverName)
      const instant = now()
      const window = (windows.get(serverName) ?? []).filter((stamp) => instant - stamp < WINDOW_MS)
      window.push(instant)
      windows.set(serverName, window)
      if (window.length <= limit) return undefined
      options.onLimited?.(serverName)
      return { kind: 'deny', reason: 'fatigue' }
    },
  }
}
