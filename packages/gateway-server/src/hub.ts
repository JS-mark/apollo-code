/**
 * 网关侧会话枢纽的结构面（apps/cli 装配时传入 @volund/web-server 的 SessionHub）。
 * 用结构类型而非直接依赖，保持 gateway-server 不反向依赖 web-server 包。
 *
 * 方法语法声明是有意的：TS 方法参数双变（bivariant），SessionHub 的
 * WebEventEnvelope 订阅签名因此结构上满足本接口，无需 adapter。
 */
export interface GatewayEnvelope {
  readonly kind: string
  readonly event: unknown
  readonly cursor?: string
  readonly sessionId?: string
}

/** 待审批卡投影（结构对齐 @volund/web-server SessionHub 的 WebPermissionRequest）。 */
export interface GatewayPermissionRequestView {
  readonly id: string
  readonly attempt: number
  readonly display: { approvable: boolean; spec: string; toolName: string }
  readonly lineage?: { sessionId: string; agentType?: string; parentTurnId?: string }
}

/** 待决提问卡投影（结构对齐 @volund/web-server SessionHub 的 WebAskRequest）。 */
export interface GatewayAskRequestView {
  readonly id: string
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description?: string }[]
}

export interface GatewayHubLike {
  readonly active: { id: string; cwd?: string } | undefined
  start(input: { cwd: string }): Promise<{ id: string }>
  resume(id: string): Promise<{ id: string }>
  submit(input: {
    prompt: string
    model?: string
    attachments?: readonly GatewaySubmitAttachment[]
  }): Promise<'accepted'>
  interrupt(): Promise<void>
  closeActive(): Promise<void>
  subscribe(listener: (envelope: GatewayEnvelope) => void): () => void
  decide(requestId: string, kind: string): boolean
  pendingPermissionIds(): string[]
  /**
   * 待审批队列完整投影（hello 后补发 permission.request 用）：仅直连 hub 提供
   * （SessionHub.pendingPermissionRequests）；relay 模式 uplink 只同步 id 面，
   * 缺省时迟到设备拿不到卡面（维持旧行为）。
   */
  pendingPermissionRequests?(): readonly GatewayPermissionRequestView[]
  /**
   * AskUserQuestion 的作答隧道（POST /v1/asks/answer 与 WS ask.answer 的终点）：
   * value 缺省 = 未作答关闭提问。布尔 = 是否确有该待决提问。
   */
  answerAsk?(requestId: string, value: string | undefined): boolean
  /** 待决提问 id 面（注册/状态帧与 hello 的快照源；缺省 = hub 不支持提问）。 */
  pendingAskIds?(): readonly string[]
  /** 待决提问完整投影（hello 后补发 ask.request 用；语义同 pendingPermissionRequests）。 */
  pendingAskRequests?(): readonly GatewayAskRequestView[]
  /**
   * 附件暂存（返回面结构对齐 @volund/shared 的 StagedAttachmentInfo）：字节以
   * base64 进站（uplink RPC 只能载 JSON），本机侧解码后进 AttachmentStore 换
   * handle。hub 不支持附件时缺省，上传端点按 gateway_unsupported_content 应答。
   */
  stageAttachment?(input: { mime: string; dataBase64: string }): Promise<GatewayStagedAttachment>
  /**
   * 附件字节回放（GET /v1/attachments/:handle；uplink RPC 只能载 JSON，字节以 base64
   * 出站，网关侧解码写二进制应答）。hub 不支持读取/handle 不存在 → undefined → 404。
   */
  readAttachment?(handle: string): Promise<GatewayAttachmentBytes | undefined>
  /** 模型清单（relay 经隧道取自本机）；缺省 = hub 不支持，/v1/models 回空列表。 */
  listModels?(): Promise<GatewayModelsView>
   * 删除会话档案（POST /v1/sessions/delete 的隧道终点）：仅 relay 场景由 RemoteHub
   * 经 uplink RPC 提供；删活动会话时本机先 end 再冷启动，session.attached/deleted
   * 视图帧经事件通道回推各端。缺省 = hub 不支持（直挂旧 hub），端点按离线应答。
   */
  deleteSession?(id: string): Promise<{ deleted: true; next?: string }>
  /**
   * 会话文件变更聚合（GET /v1/sessions/active/changes 的隧道腿；消息流变更卡片
}

/** 附件字节（uplink 回程的 base64 载荷 + 回放用的 Content-Type）。 */
export interface GatewayAttachmentBytes {
  readonly mime: string
  readonly dataBase64: string
}

/** 已暂存附件引用（内容寻址 handle 或本机路径；字节永不进事件流/日志）。 */
export interface GatewayStagedAttachment {
  readonly kind: 'file' | 'image'
  readonly mime: string
  readonly size: number
  readonly handle?: string
  readonly path?: string
}

/** turn.submit 随 prompt 携带的附件引用（chip 为客户端输入行占位 token）。 */
export interface GatewaySubmitAttachment extends GatewayStagedAttachment {
  readonly chip: string
}

/** GET /v1/models 的条目形状（OpenAI 兼容 data 数组元素）。 */
export interface GatewayModelListing {
  readonly id: string
  readonly label?: string
}

/** 本机模型面：当前生效模型 + 可切换候选（relay 经 uplink `models.list` 取自本机）。 */
export interface GatewayModelsView {
  readonly current?: string
  readonly options: readonly GatewayModelListing[]
}
