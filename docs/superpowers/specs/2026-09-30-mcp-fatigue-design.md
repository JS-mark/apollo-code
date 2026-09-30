# MCP fatigue 防护 · 设计（r1）

> **状态**：r1（2026-09-30）——依据 §11.3.9（REVIEW-r6 P1-2）的三层防护拍板立项；本片是该能力的实现设计单一事实源。
> **文档类型**：设计规约（实现前立项，未实现）
> **范围**：`packages/app-runtime`（mcp-domain 疲劳守卫 + 工具信任门）、`packages/permission`（决策 reason/kind 扩展）、`packages/ui`（TUI 审批卡 batch 合并）、`apps/web` + `apps/mobile`（审批卡 batch 呈现）、`packages/shared`（错误码 + config schema 新键）、`packages/web-server`（mcp 管理面透出信任门状态）
> **出处**：§11.3.9 三层防护 + §13 threat model「MCP server 是半信任第三方」

---

## §S0 问题与结论速览

恶意/失控 MCP server 可批量暴露 tool：每个 tool 调用都触发权限弹窗 → 疲劳轰炸用户「点 allow」。三层防护（外层粗、内层细，逐层独立可上线）：

| 层 | 机制 | 挡什么 | 单独上线价值 |
|---|---|---|---|
| F1 | per-MCP 弹窗限速 | 失控 server 高频轰炸（每分钟 N 卡） | 最高：纯后端，零 UI |
| F2 | 同源弹窗 batch 合并 | 多卡同时到队刷屏 | 中：需要三端卡面 |
| F3 | tool 上线信任门 | server 静默新增/变更危险 tool | 高：防「先装后加料」 |

## §S1 F1 · per-MCP 弹窗限速

- **计数面**：`McpFatigueGuard`（app-runtime，mcp-domain 装配）维护每 server 的交互权限请求时间窗（滑动 60s 环形）。挂在 SessionHub/PermissionPromptController **上游**——具体为 `PermissionManager` 的 promptHandler 包装：请求的 `spec.custom.mcpServer` 存在时才计入（非 MCP 请求零影响）。
- **限速值**：`mcp.toml` 每 server 可配 `max_prompts_per_minute`（config schema 新键 `mcp_servers.<name>.max_prompts_per_minute`，默认 **10**，项目级 forbidden——clone 来的仓库不得放宽轰炸上限）。
- **超限行为**：后续该 server 的交互权限请求**直接 deny**（不经队列、不弹卡），工具结果为 `mcp_fatigue_rate_limited: MCP server '<name>' is triggering approval prompts too quickly (over <N>/min); the call was denied automatically.`；telemetry `securityEvent('mcp.fatigue_rate_limited', {server})`；server 卡面 detail 提示「行为异常，已被限速」。
- **错误码**：登记 `mcp_fatigue_rate_limited`（shared error-codes + docs 双语）。
- **语义边界**：`interactionMode === 'none'` 的自动 deny 不计数（不是轰炸信号）；已被 allow 规则放行的调用不经过 prompt，不计入。

## §S2 F2 · 同源弹窗 batch 合并

- **合并条件**：同一 `custom.mcpServer` 的多个待决请求同时在队（现有 PermissionPromptController 队列天然聚合，无需计时器）。
- **卡面**：TUI `PermissionPromptStack` / web `PermissionCard` / mobile `PermissionStack` 对同源多卡渲染为一张 batch 卡：标题「MCP server <name> 请求批准 N 项」，逐条可展开明细。
- **决策选项**（§11.3.9 原文四选）：`允许此 server 全部 tool`（写 `permissions.mcp.<name>` 域级 allow-session，等价该 server tool 全 allow）/ `仅本次批量`（allow-batch-once：对本批 id 集合逐个 allow-once）/ `逐个询问`（拆回单卡）/ `拒绝此 server`（deny-batch + 该 server 本会话内后续请求静默 deny）。
- **决策面扩展**：`InteractivePermissionDecision.kind` 增 `allow-mcp-server` / `allow-batch-once` / `deny-batch`（permission 域同 trio），`PermissionManager` 消费：allow-mcp-server → 注册会话级 MCP server 域规则；allow-batch-once → 按 id 集合放行；deny-batch → 拒绝并标记 server。
- **非目标**：不做跨 server 合并（不同 server 风险域不同）；不做非 MCP 请求的 batch。

## §S3 F3 · MCP tool 上线信任门

- **信任快照**：`~/.volund/mcp-tool-trust.json`：`{ [serverName]: { toolsHash, approvedAt } }`；`toolsHash = sha256(工具名+inputSchema+permissionSpec 的 canonical JSON)`（对齐 capability-contract 的 canonical JSON 惯例）。
- **连接时判定**（mcp-domain manager ensure/connect）：计算当前 tool 集 hash 与快照比对——
  - 一致 → 照常注册。
  - 首次（无快照）或 hash 不一致 → 工具**照常注册但逐调用 fail-closed**：invoke 前检查，未批准返回 `mcp_tool_unapproved: MCP server '<name>' exposed a changed tool set; approve it in /mcp (or the web console) before calls are allowed.`；卡面/`mcp list`/web 面板状态标 `needs-trust` + 「N 个工具待确认」。
- **批准入口**：`volund mcp approve <name>`（CLI 新动作）+ REPL `/mcp` 面板 + web 管理页 MCP tab 按钮（走管理动作表 `approveTools`，web-server `McpPortLike` 加 `approveTools?(name)`）。批准即写快照 + 触发域级 reload（语义同 login 后 reload）。
- **错误码**：登记 `mcp_tool_unapproved`。
- **回滚语义**：server 配置被用户显式 remove 再 add → 快照删除，重新走首次信任门（防「删了重加绕过变更检测」）。

## §S4 非目标

1. 不做 plugin 提供的 tool 的疲劳防护（插件走插件信任链，另有 permission hash 门）。
2. 不做 allow 规则的持久化 UI 批量管理（`permissions.toml` 既有面已覆盖）。
3. F2 不做非交互面（none 模式）的 batch——none 模式本就自动 deny。

## §S5 分批与验收

| 批次 | 内容 | 验收 |
|---|---|---|
| S0 | F1 限速 + 错误码 + config 键 | 假 server 每分钟 >N 请求 → 第 N+1 起自动 deny + telemetry；MCP 外请求不受影响 |
| S1 | F2 batch 合并（三端卡面 + 决策四选） | 同 server 3 卡同时到队 → 1 张 batch 卡；四选项语义各有单测 |
| S2 | F3 信任门 + 批准入口三端 | 变更 tool 集 → 调用 fail-closed → 批准后恢复；删除重加重新走门 |

## §S6 测试落点

- app-runtime：guard 单测（时间窗、none 不计数）、信任门 hash 比对与 fail-closed。
- permission：新 kind 消费语义。
- web-server：管理动作 approveTools 透传 + 503 降级（对齐 login 先例）。
- TUI/web/mobile：batch 卡渲染 reducer 层断言。
- 守卫：`verify:error-codes` 两新码双向；`verify:config-docs` 覆盖 `max_prompts_per_minute`。
