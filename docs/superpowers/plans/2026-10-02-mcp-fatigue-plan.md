# MCP fatigue 防护 · 实现计划（r1）

> ↩ 设计单一事实源：[2026-09-30-mcp-fatigue-design.md](../specs/2026-09-30-mcp-fatigue-design.md)
> 本计划只管「怎么分步落地、每步的验收」。状态：S0 实施中（2026-10-02）。

## S0 · per-MCP 弹窗限速（本批）

| # | 事项 | 落点 | 验收 |
| --- | --- | --- | --- |
| S0-1 | `McpServerConfig.maxPromptsPerMinute` 解析（`max_prompts_per_minute`，clamp 1-600，缺省 10；user/project 同时存在取 **min**——项目只能收紧不能放宽） | `packages/app-runtime/src/mcp-domain.ts` parseMcpServerEntries | 单测：缺省 10 / clamp / min 合并 |
| S0-2 | `createMcpFatigueGuard`：每 server 滑动 60s 环形计数；`check(server)` → over ? deny；配置 30s 缓存 | `packages/app-runtime/src/mcp-fatigue.ts`（新） | 单测：超限 deny、窗口滑出恢复、未知 server 用缺省 |
| S0-3 | 决策 `reason: 'fatigue'` 贯穿 + 模型侧文案 `mcp_fatigue_rate_limited: …` | `packages/permission/src/index.ts`（reason 联合 + requestAndExecute fork）+ 错误码登记 | permission 单测 + verify:error-codes |
| S0-4 | runtime 接线：promptHandler 包装——`spec.custom.mcpServer` 存在才计数；超限直接返回 deny（不进共享队列、不弹卡）+ `securityEvent('mcp.fatigue_rate_limited')` | `apps/cli/src/runtime.ts` setPromptHandler 处 | runtime 全绿（现有 permission 测试不回归） |
| S0-5 | 文档 | error-codes（en/zh）+ fatigue spec 状态行 | docs build |

S0 明确不做：server 卡面「已限速」detail 标记（S1 随 batch 卡一起）、batch 合并（S1）、信任门（S2）。

## S1 · 同源弹窗 batch 合并（下批）

PermissionPromptController 队列聚合已是事实；只做三端卡面 batch 呈现 + 决策四选
（allow-mcp-server / allow-batch-once / 拆回单卡 / deny-batch）。
决策 kind 三兄弟进 `InteractivePermissionDecisionKind` + PermissionManager 消费。

## S2 · tool 上线信任门（再下批）

`~/.volund/mcp-tool-trust.json` canonical hash 快照；连接期比对；未批准逐调用
fail-closed（`mcp_tool_unapproved`）；`volund mcp approve` + /mcp 面板 + web 管理页
三端批准入口；remove 再 add 清快照。

## 风险与回退

- 限速误伤正常 server → `max_prompts_per_minute` 每 server 可调高（clamp 上限 600）。
- 守卫故障（配置读取失败）→ fail-open 按「无配置」用缺省 10，不阻断审批链。
- 全部行为在 promptHandler 内，出问题回退 = 摘掉包装，零残留。
