# volund 网关协议（REMOTE-GATEWAY-PROTOCOL v1）

网关是**独立的协议面**：任何按本文档实现帧协议的应用都能对接，不依赖 volund
代码库。TypeScript 实现方可以直接引用机器可读的帧类型
（`src/protocol.ts`，经 `@volund/gateway-server` 导出）。

## 角色与拓扑

```
客户端（移动站 / Web 后端 / CI）            机器（agent 运行时，如 volund 桌面端）
  REST /v1/* + WS /v1/ws  ──►  网关（公网中转）  ◄── WS /uplink（反向拨出）
```

- **网关（gateway）**：纯中转。认证、限流、路由、配对、设备注册表；不持有会话。
- **机器（machine）**：真正跑会话的 agent 运行时。不暴露端口，向网关反向拨出
  `/uplink` 并注册；客户端流量按 OAuth client 路由到对应机器。
- **客户端（client/device）**：浏览器、移动站、CI 等。REST + `/v1/ws` 驱动会话。

## 认证

`POST /oauth/token`，grant_type=client_credentials（form-urlencoded / JSON /
Basic 头均可）→ `{access_token, token_type, expires_in, scope}`。access_token 是
HS256 JWT（强制 iss/exp/签名）。scope 分面：

| scope      | 用途                                  |
| ---------- | ------------------------------------- |
| `uplink`   | 机器拨出 `/uplink`（注册 + 承接 RPC） |
| `chat`     | `/v1/chat/completions`、`/v1/ws`      |
| `sessions` | `/v1/sessions`、transcript            |

配对核销（`POST /pairing/redeem`）签发的**设备 token** 绑定机器 client，
只授 `chat` scope，默认 30 天，撤销即 401。撤销同时踢存量：该设备已建立的
`/v1/ws` 连接被网关以 `1008 device_revoked` 主动关闭（客户端应据此回配对页，
而不是带死凭证无限重连）。

## 机器面：`GET /uplink`（WebSocket）

认证：`Authorization: Bearer <token>` 或 `?access_token=`（浏览器 WS 不能设头）。
JSON 文本帧，`type` 判别；未知帧类型网关以 1002 关闭。

### 本机 → 网关（MachineFrame）

| type              | 字段                                                                                                                | 说明                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uplink.register` | `instance{instanceId, workspaceCwd, hostname?, version?, channels[], active, pendingPermissions[], pendingAsks?[]}` | **必须是首帧**；注册即路由。同 client 重连时新连接顶替旧连接（旧连接以 1008 `replaced by a newer uplink` 关闭，在途 RPC 立即失败；被顶替方应让位停连而非立即重拨，否则两个同凭证实例会互抢注册） |
| `uplink.state`    | `active`, `pendingPermissions[]`, `pendingAsks?[]`                                                                  | 活动会话/待审批/待决提问快照变化时重推；active 与 pendingPermissions 同帧成对                                                                                                                    |
| `event`           | `envelope{kind, event, sessionId?, cursor?}`                                                                        | hub 事件透传，与 `/v1/ws` 下行 event 同信封                                                                                                                                                      |
| `rpc.result`      | `id, ok, result? \| error?{code,message}`                                                                           | 网关 hub RPC 的应答                                                                                                                                                                              |
| `req`             | `ref, method, params`                                                                                               | 本机发起的命令（见下表）                                                                                                                                                                         |
| `ping`            | —                                                                                                                   | 应用级心跳 → `pong`                                                                                                                                                                              |

### 网关 → 本机（GatewayFrame）

| type                | 字段                                       | 说明                                       |
| ------------------- | ------------------------------------------ | ------------------------------------------ |
| `uplink.registered` | `serverId, version`                        | 注册确认                                   |
| `rpc`               | `id, method, params`                       | hub 方法调用，本机须实现全部方法（见下表） |
| `res`               | `ref, ok, result? \| error?{code,message}` | `req` 的应答                               |
| `pong`              | —                                          | 心跳应答                                   |

### hub RPC 方法（rpc 帧 method；本机侧实现）

| method                | params                           | result                                                                                                                             | 说明                                                                        |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `hub.start`           | `{cwd}`                          | `{id}`                                                                                                                             | 新建会话；cwd 被关进本机工作区（本机二次校验，防 symlink 逃逸）             |
| `hub.resume`          | `{id}`                           | `{id}`                                                                                                                             | 恢复会话                                                                    |
| `hub.submit`          | `{prompt, model?, attachments?}` | `'accepted'`                                                                                                                       | 提交一轮（单 runner 串行；model 别名在本机侧解析）                          |
| `hub.interrupt`       | `{}`                             | `null`                                                                                                                             | 打断在途 turn                                                               |
| `hub.closeActive`     | `{}`                             | `null`                                                                                                                             | 结束活动会话                                                                |
| `hub.decide`          | `{requestId, kind}`              | `null`                                                                                                                             | 审批决策（本机队列幂等，过期决策静默忽略）                                  |
| `hub.answerAsk`       | `{requestId, value?}`            | `null`                                                                                                                             | AskUserQuestion 作答（value 缺省=未作答关闭；本机队列幂等）                 |
| `hub.stageAttachment` | `{mime, dataBase64}`             | `{kind, mime, size, handle}`                                                                                                       | 附件暂存进 AttachmentStore（60s 超时）                                      |
| `hub.readAttachment`  | `{handle}`                       | `{mime, dataBase64} \| undefined`                                                                                                  | 附件字节回放（60s 超时；读不到回 undefined → 网关 404）                     |
| `sessions.list`       | `{}`                             | `unknown[]`                                                                                                                        | 可恢复会话清单                                                              |
| `sessions.delete`     | `{id}`                           | `{deleted: true, next?}`                                                                                                           | 删除会话档案（不存在 404；删活动会话时本机先 end 再冷启动，next=新会话 id） |
| `session.transcript`  | `{}`                             | `{id?, cwd?, transcript[]}`                                                                                                        | 活动会话持久化快照                                                          |
| `models.list`         | `{}`                             | `{current?, options: [{id,label}]}`                                                                                                | 模型清单（本机当前生效模型 + 可切换候选）                                   |
| `changes.list`        | `{}`                             | `{paths: [{path, created, batches, lastModifiedAt, allConsumed, stats?{linesAdded, linesRemoved, truncated, deleted}}], missing?}` | 会话文件变更聚合（恒带净效果行统计；BackupStore 背书）                      |
| `changes.diff`        | `{path}`                         | `{path, tracked, created, beforeAvailable, deleted, truncated?, diff, linesAdded, linesRemoved}`                                   | 单文件净效果 diff（path 须与备份记录精确匹配）                              |
| `changes.undoPreview` | `{}`                             | `{undoable, reason?, paths[], warnings[]}`                                                                                         | 撤销最近批次预览（不消费、不改盘）                                          |
| `changes.undo`        | `{}`                             | `{undone, reason?, paths[], warnings[]}`                                                                                           | 撤销最近批次（消费一批备份；幂等，无批次回 no_backup）                      |

### uplink 命令（req 帧 method；由网关应答）

| method           | params       | result                                                |
| ---------------- | ------------ | ----------------------------------------------------- |
| `pairing.create` | `{}`         | `{code, url, expiresAt}`（一次性 8 位码，5 分钟有效） |
| `devices.list`   | `{}`         | `{devices: [{id, name, pairedAt, lastSeen}]}`         |
| `device.revoke`  | `{deviceId}` | `{revoked: boolean}`（撤销即 token 失效）             |

### 同步语义（实现方注意）

- 网关侧把 `active`/`pendingPermissions` 缓存为**快照**（注册帧 + state 帧），
  同步属性被 RPC 化后仍能同步读；`hub.start/resume/closeActive` 的 RPC 应答
  会先做乐观更新，权威值以随后的 state 帧为准。
- RPC 默认 15s 超时（`504 gateway_upstream_failed`）；链路断开时在途 RPC 以
  `503 gateway_uplink_offline` 失败。
- 事件广播按来源机器过滤：客户端只收到其认证 client 对应机器的事件。

## 客户端面

### REST（Bearer）

| 端点                                           | 说明                                                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                               | 健康检查（无需认证；relay 下含 `relay.instances`）                                                                                                                                                                                                  |
| `GET /v1/models`                               | 模型清单（relay 经隧道 `models.list` 取自本机）；OpenAI `data` 形状 + `current` 默认模型字段                                                                                                                                                        |
| `GET /v1/sessions`                             | 会话清单（经隧道取自本机）                                                                                                                                                                                                                          |
| `POST /v1/sessions/delete`                     | 删除会话档案 `{id}` → `{deleted: true, next?}`（经隧道落到本机；不存在的 id 归类 404 `gateway_session_not_found`、在途 turn 409；删活动会话时本机先 end 再冷启动，next=新会话 id，各端经 `event` 信封的 `session.deleted`/`session.attached` 跟随） |
| `GET /v1/sessions/active/transcript`           | 活动会话快照（移动端刷新重建视图）                                                                                                                                                                                                                  |
| `GET /v1/sessions/active/changes`              | 活动会话文件变更聚合（relay 经隧道 `changes.list`；每路径带净效果行统计 stats；hub 未实现回 `{paths: []}`）——移动端消息流变更卡片数据源                                                                                                             |
| `GET /v1/sessions/active/changes/diff?path=`   | 单文件净效果 diff（`changes.diff`；path 缺省 400 `gateway_schema_invalid`）                                                                                                                                                                         |
| `GET /v1/sessions/active/changes/undo/preview` | 撤销最近批次预览（`changes.undoPreview`）                                                                                                                                                                                                           |
| `POST /v1/sessions/active/changes/undo`        | 撤销最近批次（`changes.undo`；破坏性，先预览确认）                                                                                                                                                                                                  |
| `POST /v1/chat/completions`                    | OpenAI 兼容；`stream:true` 走 SSE；`session_id` 扩展字段续接会话                                                                                                                                                                                    |
| `POST /v1/attachments`                         | 附件上传（原始字节直传，Content-Type 限 image/png·jpeg·gif·webp，≤20 MiB）；字节经隧道进本机 AttachmentStore，返回 `{kind,mime,size,handle}`                                                                                                        |
| `GET /v1/attachments/{handle}`                 | 附件字节回放（移动站 transcript 图片回显）；handle 即 AttachmentStore 内容寻址引用，二进制应答带不可变长缓存；读不到 → 404 `gateway_attachment_not_found`                                                                                           |
| `POST /pairing/redeem`                         | 配对码核销（无认证，IP 限流）→ 设备 token                                                                                                                                                                                                           |
| `POST /v1/pairing`                             | 铸造机器注册码（uplink scope；`{code, expiresAt}`）——多机自助接入的铸造面                                                                                                                                                                           |
| `GET /v1/instances`                            | 在线实例清单（uplink scope）：`{instances: [{client, instanceId, workspaceCwd, hostname?, version?, channels, connectedAt}]}`                                                                                                                       |
| `GET /v1/clients`                              | 已配置客户端 + 在线标记（uplink scope）：`{clients: [{id, scopes, online}]}`——只有 id/scopes，secretHash 永不出认证面                                                                                                                               |

### WebSocket `GET /v1/ws`（Bearer 或 ?access_token=）

客户端帧（ClientFrame）：`ping` / `session.start{cwd?}` / `session.resume{id}` /
`session.end` / `turn.submit{prompt, model?, attachments?}` / `turn.interrupt` /
`permission.decide{requestId, kind}` / `ask.answer{requestId, value?}`——均可带
`ref`，应答原样带回。`ask.answer` 是 AskUserQuestion 工具的作答帧（`value`
缺省 = 未作答关闭提问），与 `permission.decide` / `turn.interrupt` / `ping`
同走免队列通道；应答 `ask.answered{requestId, answered}` 的布尔 = 是否确有该
待决提问。

`attachments` 为已暂存附件的引用数组（`{kind, chip, mime, size, handle?}`，先经
`POST /v1/attachments` 换 handle）；prompt 为空时以 chip（如 `[image_1]`）占位。
hub RPC 面相应多出 `hub.stageAttachment{mime, dataBase64}`（字节 base64 进站，
60s 超时）与 `models.list`（模型清单，供 `GET /v1/models`）；uplink 连接的
WS 帧上限因此放到 32 MiB，/v1/ws 客户端面仍为 1 MiB。

服务端帧（ServerFrame）：`hello{serverId, version, session, pendingPermissions, pendingAsks?, turnRunning}`
（`turnRunning`=握手瞬间是否有 turn 在途，迟到者据此恢复运行态/中断按钮）
（连接即发）/ `pong` / `session.attached{id, cwd?}` / `session.ended` /
`turn.accepted` / `turn.interrupt_requested` /
`permission.decided{requestId, decided}` / `ask.answered{requestId, answered}` /
`event`（事件信封透传）/ `error{code, message}`。握手后网关还会一次性补投
接入前已在队列里的 `permission.request` 与 `ask.request` 视图帧（直连 hub 才有
卡面；relay 只同步 id 面，迟到设备以 hello 的 id 数组兜底）。

`event` 信封除本机透传外，网关在 relay 模式会合成两个 `kind=view` 的机器在线
状态事件：uplink 断开时 `machine.offline`、注册/重连成功时 `machine.online{cwd}`
（被新连接顶替的旧连接断开不重复发 offline）；客户端应用其提示链路状态，
命令应答里的 `gateway_uplink_offline` 错误帧是同一语义的被动兜底。
`permission.request` 视图帧经审批超时兜底通道时盖 `expiresAt`（epoch ms，绝对
截止 = 盖章时刻 + permissionTimeoutMs，到点无人决策自动 deny）——移动端审批卡
据此渲染剩余秒数倒计时；旧客户端不认识该字段，零影响。

### 配对流程

1. 机器侧 `req: pairing.create` → `{kind?, code, url, expiresAt}`；
   `kind` 缺省为 `device`（设备配对，带移动站落地 `url`），`machine` 为机器注册码
   （只进 CLI，无移动站 url）；`url` 指向移动站（`GATEWAY_MOBILE_PUBLIC_URL`，
   缺省为网关自身），形如 `<site>/#pair=CODE[&gw=<网关地址>]`。
2. 设备打开 url（或手动输入网关地址 + 配对码）→ `POST /pairing/redeem`
   `{code, name}` → `{access_token, device_id, expires_in}`。
3. 设备 token 直连 `/v1/ws` + REST；机器侧 `device.revoke` 可即时撤销。

### 机器注册流程（kind=machine）

信任模型与设备配对一致：持有已接入机器凭证 = 有权接纳新机器。

1. 已接入机器 `POST /v1/pairing`（Bearer，uplink scope）→ `{code, expiresAt}`。
2. 新机器 `POST /pairing/redeem {code}`（公开端点，同一 IP 限流）→ 网关铸造
   独立机器客户端（`chat sessions uplink`）：SHA-256 哈希追加进 clients.json
   （0600）并登记进运行时认证面，明文 secret **只在这次应答**返回
   `{client_id, client_secret, scope}`。
3. 一机一凭证：uplink 注册表按 client id 键控，同 id 重连顶替旧连接。
   `GATEWAY_CLIENTS` env 来源时注册面关闭（核销 → 404 `gateway_enrollment_disabled`）。

## 错误码

`{error: {code, message}}`：`gateway_auth_invalid`(401) /
`gateway_client_rejected`(401) / `gateway_grant_unsupported`(400) /
`gateway_rate_limited`(429) / `gateway_schema_invalid`(400/404) /
`gateway_session_busy`(409) / `gateway_session_not_found`(404) /
`gateway_unsupported_content`(400) / `gateway_upstream_failed`(502) /
`gateway_uplink_offline`(503) / `gateway_ws_protocol_error`(WS 帧内) /
`gateway_enrollment_disabled`(404，机器注册面未开放)。

## 安全约束

- `/oauth/token` 每 IP 限流（默认 30/min），`/v1/*` 每客户端限流（默认 600/min），
  `/pairing/redeem` 每 IP 限流。
- JSON body 上限 4 MiB，WS 消息上限 1 MiB；客户端帧必须掩码（RFC 6455）。
- CORS 默认关闭，`GATEWAY_CORS_ORIGINS` 显式开白名单（移动站独立部署时必须）。
- 会话 cwd 网关/本机双重 realpath 校验，不得逃逸本机工作区。

## 兼容约定

- 帧/字段**只增不改**：新增 `type`、新增 optional 字段都是兼容变更；
  接收方必须忽略未知字段。
- 破坏性变更升级协议主版本（v2 将另起文档与类型命名空间）。
