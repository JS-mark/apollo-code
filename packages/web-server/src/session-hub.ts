/**
 * SessionHub（§22.8.3 / Web 计划 P3-01/02/06 + W-01 嵌入式）：把 SessionController
 * 的会话暴露为 Web 的权威状态源——CoreEvent 透传（WebEventEnvelope + 单调 cursor）、
 * 权限审批队列（共享 PermissionPromptController → SSE 推卡 → decide 解析）、
 * turn 提交的串行化。
 *
 * 两种模式：
 * - standalone（`volund web` 独立进程）：hub 自建/恢复会话（start/resume），
 *   关闭即结束会话（owned）。
 * - embedded（随 TUI 静默启动）：挂载 controller 的当前活动会话（attachActive），
 *   TUI 内 resume/新建经 onActivate 自动重挂；start/resume/end 拒绝
 *   （web_state_conflict）——单 runner 模型下 web 不得顶替 TUI 的会话。
 *
 * 诚实边界：cursor 是内存态单调计数，重连经 GET transcript 快照 + 新 cursor 续传。
 */
import type {
  InteractiveAskRequest,
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  InteractiveSession,
  AskPromptController,
  PermissionPromptController,
  PermissionRequestLineage,
} from '@volund/app-runtime'
import type { StagedAttachmentInfo, SubmitAttachment } from '@volund/shared'

/** SessionController 的最小结构面（@volund/app-runtime 的 SessionController 结构满足）。 */
export interface SessionControllerLike {
  startInteractive?(input: { cwd: string }): Promise<InteractiveSession<unknown>>
  resumeInteractive?(id: string): Promise<InteractiveSession<unknown>>
  /** 嵌入式：当前活动会话 facade（无则 undefined）。 */
  getActive?(): InteractiveSession<unknown> | undefined
  /** 嵌入式：会话激活订阅（TUI resume/新建后重挂）。 */
  onActivate?(listener: (session: InteractiveSession<unknown>) => void): () => void
  /** 是否有 turn 在途（SessionController.turnInFlight；测试假件可缺省视为空闲）。 */
  readonly turnInFlight?: boolean
  /** 删除会话档案（SessionController.delete；未接线 → hub 报 web_capability_unavailable）。 */
  delete?(id: string): Promise<{ next?: string }>
  interrupt(): Promise<void>
  end(): Promise<void>
}

/** CoreEvent 透传信封（§22.8.3；不改 payload）。 */
export interface WebEventEnvelope {
  streamVersion: 1
  cursor: string
  kind: 'core' | 'view' | 'control'
  sessionId?: string
  event: unknown
}

/** Web 权限请求卡（InteractivePermissionRequest 的授权面投影）。 */
export interface WebPermissionRequest {
  id: string
  attempt: number
  display: { approvable: boolean; spec: string; toolName: string }
  /**
   * §2.7bis.5 U4 / §22 W-07 审批归属：子代理会话的请求携带血统
   * （主代理省略）；gateway 盲转透传给 Mobile，三端卡面同语义徽标。
   */
  lineage?: PermissionRequestLineage
}

/** Web 提问卡（AskUserQuestion 工具的待决投影；问题与选项本就随 tool.requested 出站）。 */
export interface WebAskRequest {
  id: string
  question: string
  options: InteractiveAskRequest['options']
}

export interface SessionHubPorts {
  readonly session: SessionControllerLike
  /**
   * 进程级共享审批队列（§22 W-07 多路分发）：TUI 与 Web 都是它的订阅者——
   * 任一端决策，全端清卡。装配侧（runtime）同时把它接进权限链的 prompt 源。
   */
  readonly permissions: PermissionPromptController
  /**
   * 进程级共享提问队列（AskUserQuestion 工具）：同款多路分发语义。
   * 可选——未装配（旧宿主）时提问只走 TUI/line 本地通道，不出站。
   */
  readonly asks?: AskPromptController
}

export interface SessionHubOptions {
  /** 嵌入式（随 TUI 启动）：只挂载既有会话，禁止 web 侧 start/resume/end。 */
  readonly embedded?: boolean
}

/** InteractivePermissionRequest → 出站投影（display 面即可决策面；spec/input 不出站）。 */
function projectPermissionRequest(request: InteractivePermissionRequest): WebPermissionRequest {
  return {
    id: request.id,
    attempt: request.attempt,
    display: request.display,
    ...(request.lineage ? { lineage: request.lineage } : {}),
  }
}

/** InteractiveAskRequest → 出站投影（id/question/options 即作答面）。 */
function projectAskRequest(request: InteractiveAskRequest): WebAskRequest {
  return {
    id: request.id,
    question: request.question,
    options: request.options.map((option) =>
      option.description === undefined
        ? { label: option.label }
        : { label: option.label, description: option.description },
    ),
  }
}

export class SessionHub {
  private interactive: InteractiveSession<unknown> | undefined
  /** 当前挂载是否归 hub 所有（standalone 自建=true；embedded 挂载=false）。 */
  private owned = false
  private cursor = 0
  private readonly subscribers = new Set<(envelope: WebEventEnvelope) => void>()
  private unsubscribeSession: (() => void) | undefined
  private unsubscribeActivate: (() => void) | undefined
  /**
   * 上次投影的队列签名（待审批 id 逗连）。undefined = 尚未投影过（初始空队列
   * 不发 resolved）；队首之外的变动（中间请求被决策）也会改签名——Mobile 的
   * 多请求 tab 靠完整重投影跟随队列。
   */
  private lastPermissionSignature: string | undefined
  /** 上次投影的提问队列签名（语义同 lastPermissionSignature）。 */
  private lastAskSignature: string | undefined

  constructor(
    private readonly ports: SessionHubPorts,
    private readonly options: SessionHubOptions = {},
  ) {
    // 审批队列 → view 帧：签名变化即全量重投影（request=队首，requests=完整
    // 队列）；Web 只读 request（队首），Mobile 读 requests 做多 tab。清空发
    // resolved（任一端决策，全端清卡）。
    this.ports.permissions.subscribe((requests) => {
      const signature = requests.map((request) => request.id).join(',')
      const previous = this.lastPermissionSignature
      if (signature === previous) return
      this.lastPermissionSignature = signature
      if (requests.length === 0) {
        if (previous !== undefined) this.emit('view', { type: 'permission.resolved' })
        return
      }
      const projected = requests.map(projectPermissionRequest)
      this.emit('view', {
        type: 'permission.request',
        request: projected[0]!,
        requests: projected,
      })
    })
    // 提问队列 → view 帧（ask.request/ask.resolved）：与审批队列同款签名重投影。
    this.ports.asks?.subscribe((asks) => {
      const signature = asks.map((ask) => ask.id).join(',')
      const previous = this.lastAskSignature
      if (signature === previous) return
      this.lastAskSignature = signature
      if (asks.length === 0) {
        if (previous !== undefined) this.emit('view', { type: 'ask.resolved' })
        return
      }
      const projected = asks.map(projectAskRequest)
      this.emit('view', {
        type: 'ask.request',
        request: projected[0]!,
        requests: projected,
      })
    })
  }

  get active(): { id: string; cwd?: string } | undefined {
    if (!this.interactive) return undefined
    return {
      id: this.interactive.id,
      ...(this.interactive.cwd ? { cwd: this.interactive.cwd } : {}),
    }
  }

  get embedded(): boolean {
    return this.options.embedded === true
  }

  subscribe(fn: (envelope: WebEventEnvelope) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /**
   * 档位变更广播（permissionMode port 的 subscribe 触发，装配侧接线）：
   * view 帧 {type:'permission.mode', mode} → 前端 composer 选择器实时同步。
   * 会话无关（进程级档位），sessionId 由 emit 按当前挂载附带即可。
   */
  emitPermissionMode(mode: 'ask' | 'auto' | 'full'): void {
    this.emit('view', { type: 'permission.mode', mode })
  }

  private emit(kind: WebEventEnvelope['kind'], event: unknown): void {
    this.cursor += 1
    const envelope: WebEventEnvelope = {
      streamVersion: 1,
      cursor: String(this.cursor),
      kind,
      ...(this.interactive ? { sessionId: this.interactive.id } : {}),
      event,
    }
    for (const subscriber of this.subscribers) subscriber(envelope)
  }

  /**
   * 单 runner 在途守卫：turn 进行中 start/resume 会在本机侧整体换掉 runner
   * （SessionController.activate 不查 turnFlight）——在途回复的事件流随旧总线
   * 消失、所有 UI 静默丢轮。fail closed 报 session_turn_in_progress（gateway
   * 映射 409 gateway_session_busy），等 turn 终态或先 interrupt。
   */
  private assertNoTurnInFlight(): void {
    if (this.ports.session.turnInFlight === true)
      throw Object.assign(new Error('A turn is already in flight for this session'), {
        code: 'session_turn_in_progress',
      })
  }

  /**
   * 新建会话。standalone：先收掉原活动会话（owned 结束）；embedded：detach 后
   * 经 controller 激活——onActivate 让 TUI 跟随切换，hub 不拥有会话（owned=false）。
   */
  async start(input: { cwd: string }): Promise<{ id: string }> {
    this.assertNoTurnInFlight()
    await this.closeActive()
    const interactive = await this.ports.session.startInteractive!({ cwd: input.cwd })
    this.attach(interactive, !this.embedded)
    return { id: interactive.id }
  }

  async resume(id: string): Promise<{ id: string }> {
    this.assertNoTurnInFlight()
    await this.closeActive()
    const interactive = await this.ports.session.resumeInteractive!(id)
    this.attach(interactive, !this.embedded)
    return { id: interactive.id }
  }

  /**
   * 删除会话档案（会话列表的破坏性操作）。端口未接线 → web_capability_unavailable
   * （前端据此隐藏入口）；不存在 → session_not_found；删除当前挂载会话时
   * controller 先 end 再冷启动新会话，onActivate 已把 hub 重挂到新会话
   * （session.attached 帧），这里补发 session.deleted 供各端刷新会话清单。
   */
  async deleteSession(id: string): Promise<{ deleted: true; next?: string }> {
    const del = this.ports.session.delete
    if (!del)
      throw Object.assign(new Error('session deletion is not wired'), {
        code: 'web_capability_unavailable',
      })
    const { next } = await del.call(this.ports.session, id)
    this.emit('view', { type: 'session.deleted', id })
    return { deleted: true, ...(next ? { next } : {}) }
  }

  /**
   * 嵌入式挂载：接管 controller 当前活动会话（不 end、不拥有），并订阅后续
   * 激活（TUI 内 resume/新建会换新 facade——这里自动重挂）。
   */
  attachActive(): void {
    if (!this.embedded)
      throw Object.assign(new Error('attachActive is only valid in embedded mode'), {
        code: 'web_state_conflict',
      })
    const attach = (session: InteractiveSession<unknown>) => {
      this.detach()
      this.attach(session, false)
    }
    const active = this.ports.session.getActive?.()
    if (active) attach(active)
    this.unsubscribeActivate = this.ports.session.onActivate?.(attach)
  }

  /** 嵌入式：会话生命周期（end）仍属 TUI；detach 语义保留在 closeActive。 */

  private attach(interactive: InteractiveSession<unknown>, owned: boolean): void {
    this.interactive = interactive
    this.owned = owned
    this.cursor = 0
    // CoreEvent 透传：envelope 只加外层，payload 原样（§22.8.3）。
    this.unsubscribeSession = interactive.events.subscribe((event) => {
      this.emit('core', event)
    })
    this.emit('view', { type: 'session.attached', id: interactive.id, cwd: interactive.cwd })
  }

  /** 只摘挂载不结束会话（embedded 重挂/摘挂路径）。 */
  private detach(): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.interactive = undefined
    this.owned = false
  }

  async closeActive(): Promise<void> {
    const interactive = this.interactive
    const owned = this.owned
    this.detach()
    if (!interactive) return
    // embedded 挂载不拥有会话：detach 即止（TUI 的会话由 TUI 收尾）。
    if (!owned) return
    await interactive.end()
  }

  /** 嵌入式卸载：退激活订阅 + 摘挂（进程收尾用）。 */
  dispose(): void {
    this.unsubscribeActivate?.()
    this.unsubscribeActivate = undefined
    this.detach()
  }

  /** 提交 turn：202 语义——立即返回，事件流承载结果；并发提交 409（controller mutex）。 */
  async submit(input: {
    prompt: string
    model?: string
    attachments?: readonly SubmitAttachment[]
  }): Promise<'accepted'> {
    if (!this.interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    const promise = this.interactive.submit(input.prompt, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    })
    void promise.catch((cause: unknown) => {
      this.emit('view', {
        type: 'turn.failed',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    })
    return 'accepted'
  }

  /**
   * §22 W-05 附件暂存：浏览器上传的图片字节经会话的 AttachmentStore 管线落盘
   * （内容寻址 handle；字节不进事件流/日志）。无会话或宿主不支持 → 明确错误。
   */
  /**
   * W-05 @-picker：cwd 相对路径 → 会话 attachFilePath（cwd 内 path 引用 /
   * cwd 外图片落 AttachmentStore）；语义与 TUI @ 选中逐字对齐。
   */
  async attachFilePath(path: string): Promise<import('@volund/shared').PasteAttachmentResult> {
    const interactive = this.interactive
    if (!interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    if (!interactive.attachFilePath)
      throw Object.assign(new Error('attach-by-path is not wired'), {
        code: 'web_capability_unavailable',
      })
    return interactive.attachFilePath(path)
  }

  /** W-05 @-picker 候选：会话 cwd 相对路径快照（对齐 TUI listFiles）。 */
  async listFiles(): Promise<readonly string[]> {
    const interactive = this.interactive
    if (!interactive?.listFiles) return []
    return interactive.listFiles()
  }

  async stageAttachment(bytes: Uint8Array, mime: string): Promise<StagedAttachmentInfo> {
    const interactive = this.interactive
    if (!interactive)
      throw Object.assign(new Error('no active session'), { code: 'web_session_invalid' })
    if (!interactive.stageAttachment)
      throw Object.assign(new Error('attachment staging is not wired'), {
        code: 'web_capability_unavailable',
      })
    const result = await interactive.stageAttachment(bytes, mime)
    if (result.kind !== 'attached')
      throw Object.assign(
        new Error(
          result.kind === 'unavailable' ? result.reason : `attachment rejected: ${result.kind}`,
        ),
        { code: 'web_attachment_rejected' },
      )
    return result.attachment
  }

  /** 附件字节回放（移动站 transcript 图片回显）：无会话/宿主未接线/handle 不存在 → undefined。 */
  async readAttachment(handle: string): Promise<{ mime: string; bytes: Uint8Array } | undefined> {
    return this.interactive?.readAttachment?.(handle)
  }

  async interrupt(): Promise<void> {
    await this.interactive?.interrupt?.()
  }

  /** 快照：持久化消息（流式 delta 不落盘，刷新后以此为准）。 */
  transcript(): { id?: string; cwd?: string; transcript: readonly unknown[] } {
    return {
      ...(this.interactive ? { id: this.interactive.id } : {}),
      ...(this.interactive?.cwd ? { cwd: this.interactive.cwd } : {}),
      transcript: this.interactive?.transcript ?? [],
    }
  }

  /** 决策落到共享审批队列（TUI/Web 同队列；重复/过期 decision 幂等忽略）。 */
  decide(requestId: string, kind: string, reason?: 'timeout'): boolean {
    const pending = this.ports.permissions.requests().some((request) => request.id === requestId)
    if (!pending) return false
    this.ports.permissions.decide(requestId, {
      kind: kind as InteractivePermissionDecision['kind'],
      ...(reason === 'timeout' ? { reason } : {}),
    })
    return true
  }

  /** 活动会话 id（W-08 工作台 pre-write 备份的归因锚点）；无活动会话 = undefined。 */
  getActiveSessionId(): string | undefined {
    return this.interactive?.id
  }

  pendingPermissionIds(): string[] {
    return this.ports.permissions.requests().map((request) => request.id)
  }

  /** 作答落到共享提问队列（语义同 decide；重复/过期 answer 幂等忽略）。 */
  answerAsk(requestId: string, value: string | undefined, reason?: 'timeout'): boolean {
    const asks = this.ports.asks
    if (!asks) return false
    if (!asks.requests().some((request) => request.id === requestId)) return false
    asks.decide(requestId, value, reason === 'timeout' ? 'timeout' : undefined)
    return true
  }

  pendingAskIds(): string[] {
    return this.ports.asks?.requests().map((request) => request.id) ?? []
  }

  /**
   * 待决提问队列的完整投影（gateway /v1/ws 握手补发用，语义同
   * pendingPermissionRequests）；未装配提问队列时回空。
   */
  pendingAskRequests(): WebAskRequest[] {
    return this.ports.asks?.requests().map(projectAskRequest) ?? []
  }

  /**
   * 待审批队列的完整投影（gateway /v1/ws 握手补发用）：迟到接入的设备拿不到
   * 之前的 permission.request 帧——靠 hello 后一次性补投。仅直连 hub 提供；
   * relay 模式 uplink 只同步 id 面，缺省即回退旧行为。
   */
  pendingPermissionRequests(): WebPermissionRequest[] {
    return this.ports.permissions.requests().map(projectPermissionRequest)
  }
}
