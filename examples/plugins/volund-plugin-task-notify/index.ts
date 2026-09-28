/**
 * volund-plugin-task-notify — 定时任务运行终态 webhook 通知（W-17 r1.5 示例插件）。
 *
 * 演示 hooks.on('task.completed' / 'task.failed') 订阅（宿主 broadcastPluginLifecycleHook
 * 广播，payload = §2.3 同名事件 payload + sessionId）+ volund.http.fetch 出网 +
 * /task-notify 斜杠命令做配置面板（storage 持久化）。复制本目录改造即可接入
 * 钉钉 / Slack / 企业微信 / 自建接收端。
 *
 * 分工与覆盖面（W17-scheduler-design r1.5）：daemon 侧 `[tasks].webhook_url` 是
 * 全终态权威通道——超时击杀 / config drift / trust 丢失 / boot 收尸无会话载体，
 * 只有它看得到；本插件跑在任务子会话里，覆盖「子进程活着走完回合」的成败，
 * 价值在进程内增强路由——按任务分流 + 按接收端格式化。
 *
 * 配置（/task-notify，配置持久化在插件 storage）：
 * - `/task-notify`                  查看当前配置与用法
 * - `/task-notify <url>`            设置默认接收端（全部任务）
 * - `/task-notify <taskId> <url>`   为单个任务设置接收端（覆盖默认）
 * - `/task-notify remove <taskId>`  删除单任务路由
 * - `/task-notify off`              清空全部配置
 *
 * 出网域由 manifest permissions.net.allowlist 把门（deny-by-default）：换接收端
 * host 时同步编辑本清单。已预放钉钉机器人与 Slack incoming webhook 两个 host；
 * 请求体按 host 自动选形——钉钉 {msgtype,text}、Slack {text}、其余通用 JSON。
 */
import type { VolundBridge } from '@volund/plugin-sdk'

/** hooks.on task.* payload（broadcastPluginLifecycleHook 广播形状，§2.3 payload + sessionId）。 */
interface TaskHookPayload {
  sessionId: string
  taskId: string
  runId: string
  scheduledFor: number
  durationMs?: number
  reason?: string
}

interface NotifyConfig {
  defaultUrl?: string
  routes?: Record<string, string>
}

const STORAGE_KEY = 'notify-config'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readConfig(raw: unknown): NotifyConfig {
  if (!isRecord(raw)) return {}
  const defaultUrl = typeof raw['defaultUrl'] === 'string' ? raw['defaultUrl'] : undefined
  const routes: Record<string, string> = {}
  if (isRecord(raw['routes'])) {
    for (const [task, url] of Object.entries(raw['routes'])) {
      if (typeof url === 'string' && url !== '') routes[task] = url
    }
  }
  return { ...(defaultUrl ? { defaultUrl } : {}), routes }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function formatText(event: 'task.completed' | 'task.failed', payload: TaskHookPayload): string {
  const duration =
    typeof payload.durationMs === 'number' && payload.durationMs > 0
      ? `，耗时 ${(payload.durationMs / 1000).toFixed(1)}s`
      : ''
  const run = `（run ${shortId(payload.runId)}${duration}）`
  if (event === 'task.completed') return `✅ 定时任务 ${payload.taskId} 运行完成${run}`
  const reason = payload.reason === 'interrupted' ? '，会话被中止' : ''
  return `❌ 定时任务 ${payload.taskId} 运行失败${run}${reason}`
}

/** 请求体按接收端 host 选形：钉钉 / Slack / 通用 JSON。 */
function buildBody(
  url: string,
  text: string,
  event: 'task.completed' | 'task.failed',
  payload: TaskHookPayload,
): Record<string, unknown> {
  if (url.includes('oapi.dingtalk.com')) return { msgtype: 'text', text: { content: text } }
  if (url.includes('hooks.slack.com')) return { text }
  return {
    text,
    event,
    taskId: payload.taskId,
    runId: payload.runId,
    sessionId: payload.sessionId,
    ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
}

export async function activate(volund: VolundBridge) {
  const notify = async (event: 'task.completed' | 'task.failed', payload: TaskHookPayload) => {
    if (typeof payload.taskId !== 'string' || payload.taskId === '') return
    const config = readConfig(await volund.storage.get(STORAGE_KEY))
    const url = payload.taskId in (config.routes ?? {}) ? config.routes?.[payload.taskId] : config.defaultUrl
    if (!url) return // 未配置接收端：静默跳过
    await volund.http.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildBody(url, formatText(event, payload), event, payload),
    })
  }

  volund.hooks.on('task.completed', (payload) => notify('task.completed', payload as TaskHookPayload))
  volund.hooks.on('task.failed', (payload) => notify('task.failed', payload as TaskHookPayload))

  await volund.commands.register({
    name: 'task-notify',
    order: 58,
    description: '定时任务 webhook 通知配置（示例插件 task-notify）',
    handler: async (args) => {
      const config = readConfig(await volund.storage.get(STORAGE_KEY))
      const [first, second] = args
      if (!first) {
        const routes = Object.entries(config.routes ?? {})
        if (routes.length === 0 && !config.defaultUrl)
          return [
            '任务通知未配置。',
            '用法：/task-notify <url> 设默认接收端；/task-notify <taskId> <url> 按任务；',
            '/task-notify remove <taskId>；/task-notify off',
          ].join('\n')
        return [
          ...(config.defaultUrl ? [`默认接收端：${config.defaultUrl}`] : []),
          ...routes.map(([task, url]) => `${task} → ${url}`),
        ].join('\n')
      }
      if (first === 'off') {
        await volund.storage.set(STORAGE_KEY, {})
        return '已清空任务通知配置'
      }
      if (first === 'remove') {
        if (!second) return '用法：/task-notify remove <taskId>'
        if (!config.routes?.[second]) return `没有 ${second} 的单任务路由`
        const routes = { ...config.routes }
        delete routes[second]
        await volund.storage.set(STORAGE_KEY, {
          ...(config.defaultUrl ? { defaultUrl: config.defaultUrl } : {}),
          routes,
        })
        return `已删除 ${second} 的路由`
      }
      if (!second) {
        if (!isHttpUrl(first)) return '需要 http(s) URL：/task-notify <url>'
        await volund.storage.set(STORAGE_KEY, {
          defaultUrl: first,
          ...(config.routes ? { routes: config.routes } : {}),
        })
        return `默认接收端已设置：${first}`
      }
      if (!isHttpUrl(second)) return `第二个参数需要 http(s) URL：/task-notify <taskId> <url>`
      await volund.storage.set(STORAGE_KEY, {
        ...(config.defaultUrl ? { defaultUrl: config.defaultUrl } : {}),
        routes: { ...config.routes, [first]: second },
      })
      return `任务 ${first} → ${second}`
    },
  })

  await volund.log.info('volund-plugin-task-notify activated')
}
