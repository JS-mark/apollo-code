# 整改执行监督体系（监控 Agent + 主 Agent + 经验库）

> 交付物：[`monitor-agent.md`](./monitor-agent.md)（单任务验收）· [`coordinator-agent.md`](./coordinator-agent.md)（跨任务总控）· [`../lessons-learned.md`](../lessons-learned.md)（经验库）
> 监控对象：[`2026-08-15-design-remediation.md`](../2026-08-15-design-remediation.md) 的 WP1–WP6 / REM-1–25。模式可复制到后续任意任务计划。

## 三个角色

| 角色 | 承载 | 职责 | 产出 |
|---|---|---|---|
| 执行 agent | 任意开发会话 | 按 PLAN 执行 REM；提交信息带编号 `REM-N: ...`；文档类与代码类改动按方案拆分 PR | 代码/文档变更 |
| 监控 agent | 主会话 spawn `general-purpose` 子代理（**不要用 Explore**：需要跑测试和写报告） | 单任务验收：四层验证 + 结构化报告 + 单任务经验 | `reports/<TASK>-<date>.md` |
| 主 agent | 主会话直接执行 coordinator 提示词（或新会话粘贴） | 汇总矩阵、模式识别、整体判定、跨任务经验沉淀与晋升提案 | `reports/round-<N>.md` |

## 流程

```
执行 agent 完成 REM-N
        │  （提交信息含 REM-N，必要时告知 commit 范围）
        ▼
主会话 spawn 监控 agent ──► reports/REM-N-<date>.md ──┐
        │                                              ├─► 主 agent 跑一轮汇总
执行下一个 REM …                                        │      │
                                                       ───────┘      ▼
                                              PLAN 打状态标注 + lessons-learned 更新
                                              + round-N 报告（风险/复验/下一批建议）
```

## 触发节奏（建议，可调）

- **监控 agent**：每个 REM 完成即审（小任务）；WP 级大项（如 WP2 spec 回收）按其内部清单分批审。
- **主 agent**：每完成一个 WP，或累计 ≥5 份验收报告，或任一 P0 项 FAIL/BLOCKED 时立即跑一轮。

## 经验库约定（见 ../lessons-learned.md 顶部）

- 条目三段式：问题 → 根因 → **可执行规则**；单条 ≤15 行。
- 只追加/更新，不删历史；同根因更新而非新建；命中 ≥2 次可晋升为治理文档条款**提案**（提案制，不直改 AGENT.md）。

## 已知局限（诚实声明）

1. **任务边界依赖提交纪律**：执行 agent 混合提交（一个 commit 夹多个 REM）会导致监控 UNVERIFIABLE——靠 `REM-N:` 提交约定缓解。
2. **动态验证有副作用面**：跑测试本身可能写临时文件/起子进程；只允许仓库既有 scripts，不允许监控 agent 发明命令。
3. **应试风险**：执行 agent 若提前看过验收标准可能针对性应付；监控的 L3 负向证伪是缓解而非根除。
4. **主 agent 不重验**：整体判定质量受单报告质量上限约束，故有"需复验"通道。
