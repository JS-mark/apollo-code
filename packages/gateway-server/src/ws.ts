/**
 * /v1/ws 交互会话通道：全双工 JSON 帧承载会话生命周期 + turn 提交 + 权限审批。
 *
 * 客户端 → 服务端帧（全部 JSON 文本帧，`type` 判别）：
 * - `ping`                                  → `pong`
 * - `session.start`    {cwd?}               → `session.attached`（cwd 限 workspace 内）
 * - `session.resume`   {id}                 → `session.attached`
 * - `session.end`                           → `session.ended`
 * - `turn.submit`      {prompt, model?, attachments?} → `turn.accepted`（串行排队，忙时等锁）
 * - `turn.interrupt`                        → `turn.interrupt_requested`
 * - `permission.decide` {requestId, kind}   → `permission.decided`
 * - `ask.answer`       {requestId, value?}  → `ask.answered`
 *
 * 服务端 → 客户端帧：
 * - `hello`（握手成功即发，含 serverId/version/当前活动会话）
 * - `event`（hub 信封透传：core=CoreEvent，view=permission.request 等视图事件）
 * - 上述各应答 + `error`（{code, message}，请求级错误，含回显 ref）
 *
 * 锁语义：turn.submit 与 session 生命周期命令进 FIFO 队列（与 chat/completions
 * 共用）；permission.decide / turn.interrupt / ping 不进队列（审批不能排在
 * 被审批的 turn 后面）。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { classifyHubError } from './chat'
import type { GatewayEnvelope, GatewayHubLike } from './hub'
import { parseClientAttachments } from './protocol'
import { GatewayError, TurnQueue } from './queue'
import type { WsConnection } from './websocket'
import { WS_CLOSE } from './websocket'

export interface WsChannelDeps {
  readonly hub: GatewayHubLike
  readonly queue: TurnQueue
  readonly workspaceCwd: string
  readonly queueTimeoutMs: number
  /** turn 持锁上限（默认 30min）：runner 静默卡死时强制放行队列。 */
  readonly maxTurnHoldMs: number
  readonly serverId: string
  readonly version: string
  /** 排障日志（命令错误帧/handler 异常）；缺省静默。 */
  readonly logger?: (message: string) => void
}

/** cwd 禁出 workspace（realpath 双端解析，防 symlink 逃逸）。 */
async function confineCwd(workspace: string, requested: string | undefined): Promise<string> {
  if (!requested) return workspace
  const candidate = isAbsolute(requested) ? requested : resolve(workspace, requested)
  const [realCandidate, realWorkspace] = await Promise.all([
    realpath(candidate).catch(() => undefined),
    realpath(workspace),
  ])
  if (!realCandidate)
    throw new GatewayError('gateway_schema_invalid', 400, `cwd does not exist: ${requested}`)
  const rel = relative(realWorkspace, realCandidate)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel)))
    throw new GatewayError('gateway_schema_invalid', 400, 'cwd escapes the gateway workspace')
  return realCandidate
}

/** 等当前 turn 终态（完成/中断/失败）后释放队列锁；maxHoldMs 兜底防 runner 静默卡死。 */
function holdQueueUntilTurnEnd(hub: GatewayHubLike, release: () => void, maxHoldMs: number): void {
  const detach = hub.subscribe((envelope) => {
    const event = envelope.event as { type?: unknown }
    if (!event || typeof event.type !== 'string') return
    if (
      (envelope.kind === 'core' &&
        (event.type === 'turn.completed' || event.type === 'turn.aborted')) ||
      (envelope.kind === 'view' && event.type === 'turn.failed')
    ) {
      clearTimeout(timer)
      detach()
      release()
    }
  })
  const timer = setTimeout(() => {
    detach()
    release()
  }, maxHoldMs)
  timer.unref?.()
}

export function attachWsConnection(deps: WsChannelDeps, conn: WsConnection): void {
  const send = (value: unknown) => conn.send(JSON.stringify(value))
  send({
    type: 'hello',
    serverId: deps.serverId,
    version: deps.version,
    session: deps.hub.active ?? null,
    pendingPermissions: deps.hub.pendingPermissionIds(),
    pendingAsks: deps.hub.pendingAskIds?.() ?? [],
    // 迟到者恢复：turn 进行中接入的设备拿不到 turn.started 事件——
    // 用队列锁状态把运行态一次性补给 hello（终态事件随订阅正常送达）。
    turnRunning: deps.queue.locked,
  })
  // 迟到者恢复（审批面）：接入前已在队列里的权限请求不会再有 permission.request
  // 帧了——握手后一次性补投完整队列（display 投影，与订阅帧同形状）。直连 hub
  // 才有此面；relay 的 uplink 只同步 id，缺省跳过维持旧行为。
  const pendingRequests = deps.hub.pendingPermissionRequests?.() ?? []
  if (pendingRequests.length > 0)
    send({
      type: 'event',
      streamVersion: 1,
      cursor: '0',
      kind: 'view',
      ...(deps.hub.active ? { sessionId: deps.hub.active.id } : {}),
      event: {
        type: 'permission.request',
        request: pendingRequests[0],
        requests: pendingRequests,
      },
    })
  // 迟到者恢复（提问面）：同款补投（ask.request 全队列）。
  const pendingAsks = deps.hub.pendingAskRequests?.() ?? []
  if (pendingAsks.length > 0)
    send({
      type: 'event',
      streamVersion: 1,
      cursor: '0',
      kind: 'view',
      ...(deps.hub.active ? { sessionId: deps.hub.active.id } : {}),
      event: {
        type: 'ask.request',
        request: pendingAsks[0],
        requests: pendingAsks,
      },
    })

  conn.onMessage = (text) => {
    void handleFrame(text).catch((cause) => {
      deps.logger?.(`ws handler failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }

  const replyError = (ref: string | undefined, cause: unknown) => {
    const error =
      cause instanceof GatewayError
        ? cause
        : new GatewayError(
            'gateway_upstream_failed',
            502,
            cause instanceof Error ? cause.message : String(cause),
          )
    deps.logger?.(`ws command error: ${error.code} ${error.message}`)
    send({ type: 'error', ...(ref ? { ref } : {}), code: error.code, message: error.message })
  }

  const handleFrame = async (text: string): Promise<void> => {
    let frame: { type?: unknown; ref?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      send({ type: 'error', code: 'gateway_ws_protocol_error', message: 'frame must be JSON' })
      return
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      send({ type: 'error', code: 'gateway_ws_protocol_error', message: 'frame.type is required' })
      return
    }
    const ref = typeof frame.ref === 'string' ? frame.ref : undefined
    const body = frame as Record<string, unknown>
    switch (frame.type) {
      case 'ping':
        send({ type: 'pong', ...(ref ? { ref } : {}) })
        return
      case 'permission.decide': {
        const requestId = body.requestId
        const kind = body.kind
        if (typeof requestId !== 'string' || typeof kind !== 'string') {
          replyError(
            ref,
            new GatewayError('gateway_schema_invalid', 400, 'requestId and kind are required'),
          )
          return
        }
        send({
          type: 'permission.decided',
          ...(ref ? { ref } : {}),
          requestId,
          decided: deps.hub.decide(requestId, kind),
        })
        return
      }
      case 'ask.answer': {
        const requestId = body.requestId
        const rawValue = body.value
        if (
          typeof requestId !== 'string' ||
          !(rawValue === undefined || typeof rawValue === 'string')
        ) {
          replyError(ref, new GatewayError('gateway_schema_invalid', 400, 'requestId is required'))
          return
        }
        send({
          type: 'ask.answered',
          ...(ref ? { ref } : {}),
          requestId,
          answered: deps.hub.answerAsk?.(requestId, rawValue) ?? false,
        })
        return
      }
      case 'turn.interrupt':
        await deps.hub.interrupt()
        send({ type: 'turn.interrupt_requested', ...(ref ? { ref } : {}) })
        return
      case 'session.start':
      case 'session.resume':
      case 'session.end':
      case 'turn.submit': {
        // 进队列的命令：等锁 → 执行 → turn 类命令持锁到终态。
        let release: () => void
        try {
          release = await deps.queue.acquire(deps.queueTimeoutMs)
        } catch (cause) {
          replyError(ref, cause)
          return
        }
        try {
          if (frame.type === 'session.start') {
            const cwd = await confineCwd(
              deps.workspaceCwd,
              typeof body.cwd === 'string' ? body.cwd : undefined,
            )
            const started = await deps.hub.start({ cwd })
            send({ type: 'session.attached', ...(ref ? { ref } : {}), id: started.id, cwd })
            release()
            return
          }
          if (frame.type === 'session.resume') {
            const id = body.id
            if (typeof id !== 'string' || !id) {
              release()
              replyError(ref, new GatewayError('gateway_schema_invalid', 400, 'id is required'))
              return
            }
            try {
              await deps.hub.resume(id)
            } catch (cause) {
              release()
              // classifyHubError 与 chat/completions 同一张映射表：Session not
              // found → 404，session_turn_in_progress/busy → 409（本机在途 turn
              // 未结束），其余 → 502。
              replyError(
                ref,
                /not found|invalid session/i.test(
                  cause instanceof Error ? cause.message : String(cause),
                )
                  ? new GatewayError('gateway_session_not_found', 404, `session not found: ${id}`)
                  : classifyHubError(cause),
              )
              return
            }
            send({ type: 'session.attached', ...(ref ? { ref } : {}), id })
            release()
            return
          }
          if (frame.type === 'session.end') {
            await deps.hub.closeActive()
            send({ type: 'session.ended', ...(ref ? { ref } : {}) })
            release()
            return
          }
          // turn.submit
          const prompt = body.prompt
          if (typeof prompt !== 'string' || !prompt.trim()) {
            release()
            replyError(ref, new GatewayError('gateway_schema_invalid', 400, 'prompt is required'))
            return
          }
          const attachments = parseClientAttachments(body.attachments)
          if (attachments === undefined) {
            release()
            replyError(
              ref,
              new GatewayError('gateway_schema_invalid', 400, 'attachments are malformed'),
            )
            return
          }
          if (!deps.hub.active) {
            release()
            replyError(
              ref,
              new GatewayError(
                'gateway_schema_invalid',
                400,
                'no active session; send session.start first',
              ),
            )
            return
          }
          try {
            await deps.hub.submit({
              prompt,
              ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
              ...(attachments.length ? { attachments } : {}),
            })
          } catch (cause) {
            release()
            replyError(ref, classifyHubError(cause))
            return
          }
          send({ type: 'turn.accepted', ...(ref ? { ref } : {}) })
          holdQueueUntilTurnEnd(deps.hub, release, deps.maxTurnHoldMs)
          return
        } catch (cause) {
          release()
          replyError(ref, classifyHubError(cause))
        }
        return
      }
      default:
        send({
          type: 'error',
          ...(ref ? { ref } : {}),
          code: 'gateway_ws_protocol_error',
          message: `unknown frame type: ${frame.type}`,
        })
    }
  }
}

/**
 * WS 广播扇出：hub 事件 → 全部已认证连接。
 *
 * 事件源带 client 标记（relay 模式下来自某台已注册机器的 uplink）：连接只在
 * 自己归属机器有事件时收到广播——不同机器的会话流互不可见。直挂模式事件源
 * 为 undefined，广播不筛。
 *
 * 连接同时记录设备 id（设备 token 的 sub）：设备被撤销时按 id 踢掉存量连接——
 * 否则握手后授权不再复核，被撤销的设备会一直占用已建立的连接收发消息。
 */
export class WsBroadcaster {
  private readonly connections = new Map<
    WsConnection,
    { client: string | undefined; deviceId: string | undefined }
  >()

  constructor(
    subscribe: (
      listener: (source: string | undefined, envelope: GatewayEnvelope) => void,
    ) => () => void,
  ) {
    subscribe((source, envelope) => this.broadcast({ type: 'event', ...envelope }, source))
  }

  add(conn: WsConnection, client: string | undefined, deviceId?: string): void {
    this.connections.set(conn, { client, deviceId })
    conn.onClose = () => this.connections.delete(conn)
  }

  get size(): number {
    return this.connections.size
  }

  /** 撤销设备：关闭该设备的全部客户端连接（policy 关闭码 + 原因，移动端据此回配对页）。 */
  closeDevice(deviceId: string): void {
    for (const [conn, meta] of this.connections) {
      if (meta.deviceId === deviceId) conn.close(WS_CLOSE.policy, 'device_revoked')
    }
  }

  /**
   * uplink 重连：该机器的存量客户端连接还绑着已 close 的旧 RemoteHub，命令面
   * 会一直 503——注册成功即整体踢掉（serviceRestart 关闭码），客户端按瞬断
   * 退避重连，握手时重新解析到新 hub。
   */
  closeClient(client: string, code: number, reason: string): void {
    for (const [conn, meta] of this.connections) {
      if (meta.client === client) conn.close(code, reason)
    }
  }

  closeAll(code: number = WS_CLOSE.goingAway, reason: string = 'server shutting down'): void {
    for (const conn of this.connections.keys()) conn.close(code, reason)
    this.connections.clear()
  }

  private broadcast(value: unknown, source: string | undefined): void {
    const text = JSON.stringify(value)
    for (const [conn, meta] of this.connections) {
      if (meta.client !== undefined && source !== undefined && meta.client !== source) continue
      conn.send(text)
    }
  }
}
