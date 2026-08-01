> ↩ [返回索引 (README)](./README.md) · ← [上一章: §14 Onboarding](./14-onboarding.md)

---

## §15 自我进化框架（Self-Evolution Framework）

> **本节为 r10 新增**：响应用户原则「核心智能层需要不断自我进化」。本节定义一个**贯穿 apollo 所有能力的反馈闭环框架**——让 context 管理、router、retry、tool 超时等运行时参数能根据使用信号渐进式自我调优，同时保持安全边界冻结、人可审计、可回滚、可关闭。

### 15.1 设计目标与边界

| 目标 | 含义 |
|---|---|
| **模型主导** | 进化引擎（一个常驻 core 模块）根据观察信号自主提出调参假设并小步调整，无需人逐个审批每个参数 |
| **人可审计** | 所有调整进 `~/.apollo/tuning/audit.jsonl`，用户随时可查看、回滚、关闭 |
| **渐进** | 单次调整步长受限（±10% 或固定小步），杜绝突变；恶化连续 N 次自动回滚 |
| **可回滚** | 每次调整记 before/after 值，`apollo evolution rollback` 一键还原 |
| **可关闭** | `config.toml [evolution] enabled = false` 全局关闭进化，参数回到内置默认 |
| **安全边界冻结** | 沙箱 profile / permission 决策链 / untrusted 包裹 / dangerous-* 行为 **永不参与自调优** |

**非目标**（明确不做）：
- ❌ 全自动无监督进化：累计大调整（跨阈值）需人确认（§15.6）
- ❌ 进化安全边界：§4/§5 的安全契约是人工设定的硬约束，进化系统只能观察不能改
- ❌ 跨用户聚合学习：隐私红线（对齐 AGENT.md §4.13），进化只基于本机本用户信号
- ❌ 预测性调优（提前改参数）：只基于已发生的信号反应式调整，不预测

### 15.2 双层记忆模型

进化系统学到的东西分两类，分别存不同载体（对应 r10 用户决策）：

#### Layer A —— Memory（`scope: 'tuning'`）· 模型可读的模式/偏好/教训

复用 §6.12 Memory 系统，新增 `scope: 'tuning'`（与 `global` / `project` 并列）。存的是**自然语言描述的经验**，模型经 `Memory.recall` 召回后作为行为参考（soft，非强制）：

```markdown
---
id: mem_tuning_01H8...
scope: tuning                          # ★ 新增 scope 值
title: "用户偏好简洁回答，不要长篇解释"
tags: [response-style, preference]
source: evolution                      # 'evolution' = 进化引擎写入
pinned: false
created: 2026-08-01T12:00:00Z
updated: 2026-08-01T12:00:00Z
---
观察：最近 20 次回复中，用户 5 次在 assistant 长回复后立即发"简短点"或中断。
结论：本用户偏好简洁。模型回答时应优先给出结论 + 关键步骤，背景解释放最后或省略。
```

**特点**：
- 模型可读（经 `Memory.recall({ scope: 'tuning' })` 召回进 context）
- 用户可编辑（`apollo memory edit <id>`，§6.12.7 CLI 复用）
- 走 §6.12.6 已有 `memory.preWrite` 脱敏 hook
- 进化引擎写入时 `source: 'evolution'`，与 `source: 'model'` 区分

#### Layer B —— tuning 配置（`~/.apollo/tuning/*.jsonl`）· 机器应用的调优参数

每个能力节点一个 tuning namespace，存**结构化的参数 + 观察信号 + 调整历史**：

```
~/.apollo/tuning/
├─ context.jsonl       # ContextPolicy 参数（compaction_threshold / target_ratio / ...）
├─ router.jsonl        # Router 参数（fallback 优先级 / cooldown / ...）
├─ retry.jsonl         # Retry 参数（同 provider 重试次数 / 退避系数）
├─ tool-timeout.jsonl  # 各 tool timeoutMs
└─ audit.jsonl         # ★ 所有调整的统一审计日志（人可审计/回滚）
```

每个 namespace 文件格式（以 `context.jsonl` 为例）：

```jsonl
{"param":"compaction_threshold","value":0.85,"source":"builtin","at":"2026-08-01T00:00:00Z","reason":"initial"}
{"param":"compaction_threshold","value":0.90,"source":"evolution","at":"2026-08-01T12:00:00Z","reason":"observed 3/10 post-compact repeats; raised to reduce over-aggressive compaction","signal":{"post_compact_repeat_rate":0.3}}
{"param":"compaction_threshold","value":0.88,"source":"evolution","at":"2026-08-02T00:00:00Z","reason":"after raising to 0.90, context_length errors increased 2x; partially reverted","signal":{"context_length_error_rate":0.15}}
```

**特点**：
- 机器可读，程序应用（Runner 启动时读当前值注入各能力节点）
- 每行一次调整（append-only，可回溯）
- `audit.jsonl` 是跨 namespace 的统一审计视图

### 15.3 通用进化循环（Observation → Hypothesis → Adjustment → Validation）

```
每个接入进化的能力节点运行时:

1. Observation（收集信号）
   - 各节点定义自己的信号采集（见 §15.4 矩阵）
   - 信号写入对应 tuning namespace 的 signal 段（滑动窗口，最近 N 次）

2. Hypothesis（判断是否需要调参）
   - 进化引擎（packages/core 内 EvolutionEngine 模块）周期性扫描各 namespace 的信号
   - 规则化判断（v1，不做 ML）：
     例：context namespace 的 post_compact_repeat_rate > 0.2 且 sample ≥ 10 → 假设"压缩过激"
   - 不满足任何规则 → 不调整（保持当前值）

3. Adjustment（小步调整）
   - 步长受限：单次 ≤ ±10% 或固定小步（如 threshold ±0.05）
   - 写入 tuning namespace（append 一行）+ audit.jsonl
   - 触及"大调整阈值"（见 §15.6）→ 弹窗等人确认，不自动应用

4. Validation（观察调整后信号）
   - 下一个采样窗口对比调整前后的信号
   - 恶化（如调高 threshold 后 context_length 错误率翻倍）→ 自动回滚到上一个值
   - 连续 N=3 次恶化 → 标记该参数"不适合自调优"，停止自动调整（记 audit）
```

**采样窗口**：默认每 20 次相关事件（如 20 次压缩、20 次 provider 调用）为一个采样窗口；窗口内信号聚合后才评估，避免单次噪声触发调整。

### 15.4 进化接入点矩阵（贯穿性体现）

| 能力节点 | 可调参数 | 观察信号 | 调整策略 | 落地里程碑 |
|---|---|---|---|---|
| **ContextPolicy**（§8b） | `compaction_threshold` / `target_ratio` / `keep_recent` / `summary_keep_recent` | 压缩后用户重复信息频率 / `context_length` 错误率 / summary 失败率 | 频繁重复→提高 threshold；频繁超限→降低 | **L2**（首个进化点） |
| **Router**（§3） | fallback 优先级权重 / `cooldownSeconds` | 各 provider 失败率 / fallback 后用户中断率 | 某 provider 失败率高→降优先级 | L3 |
| **Retry**（§3.9a） | 同 provider 重试次数 / 退避系数（1s/4s） | 重试成功率 / 重试后仍失败比例 | 重试常成功→可增加次数；重试常失败→减少（避免浪费 token） | L3 |
| **Tool 超时**（§4） | 各 tool `timeoutMs` | tool 超时频率 / 超时后用户重试频率 | 常超时的 tool 延长 timeout | L3 |
| **Sandbox**（§5） | ❌ **不可调**（安全边界冻结） | violation 频率 / tier 降级频率（仅观察） | 仅观察，发现高频 violation 记 Memory(scope=tuning) 教训提示用户 | 不接入（观察 only） |
| **Hook priority**（§6.11） | ❌ **不可自动调**（人工设） | hook veto 频率（仅观察） | 仅观察 | 不接入（观察 only） |

**为什么 Sandbox / Hook priority 不接入**：这两类参数直接关系安全/正确性。沙箱 profile 一改可能开逃逸口子；hook priority 一改可能让恶意插件抢 builtin。进化系统只能**观察**它们（发现异常记教训），不能**调整**它们。

### 15.5 安全护栏

| 护栏 | 规则 |
|---|---|
| **安全参数冻结** | sandbox profile / permission 决策链（§4.4）/ untrusted 包裹（§6.5.0a）/ `dangerous-*` 行为 / hook priority 分域（§6.11.1）**永不参与自调优** |
| **单次步长受限** | 数值参数单次调整 ≤ ±10% 或固定小步（threshold ±0.05 / timeout ±10s / retry 次数 ±1）；超过步长的"建议"必须走人确认 |
| **恶化自动回滚** | 调整后下一窗口信号恶化 → 自动回滚；连续 3 次恶化 → 标参数为"不适合自调优"停止自动调整 |
| **全局可关闭** | `config.toml [evolution] enabled = false` → 进化引擎停用，所有参数回内置默认；`[evolution] namespaces = ['context']` 可按 namespace 细粒度开关 |
| **审计完整** | 所有调整（含自动回滚）进 `~/.apollo/tuning/audit.jsonl`，含 before/after/reason/signal；`apollo evolution show` 查看；`apollo evolution rollback [--namespace X --to <timestamp>]` 回滚 |
| **不跨用户** | 进化只基于本机本用户信号；绝不聚合多用户数据（隐私红线，对齐 AGENT.md §4.13） |
| **脱敏** | tuning 日志的 signal 段不含 prompt/代码明文，只含聚合指标（频率/计数/比率）；`shared.sanitize()` 在写入前强制 |

### 15.6 人机协作（哪些需人确认）

| 调整类型 | 处理 |
|---|---|
| **小幅调整**（步长内，低风险参数如 context threshold） | 静默应用 + 记 audit；UI 状态栏可有可无的小标记"进化中" |
| **累计大调整**（某参数累计偏离默认 > 30%） | 弹窗确认：「参数 X 已从默认 0.85 累计调到 0.95，是否保留？[保留/回滚/设为默认]」 |
| **首次启用新 namespace** | 弹窗介绍该 namespace 会观察什么、调什么，用户 opt-in |
| **任何安全相关参数** | 永不自动调整；用户手动改需走 §12.5b RFC + 人审批 |

**进化引擎不是黑箱**：用户随时 `apollo evolution show` 看到当前所有参数偏离默认多少、近期调整历史、各信号当前值。进化系统的目标是用得越久越贴合本用户，但**用户始终是最终决策者**。

### 15.7 边界与安全清单

| 规则 | 强制点 |
|---|---|
| 安全相关参数（sandbox / permission / untrusted / hook priority）**禁止**参与自调优 | EvolutionEngine 白名单单元测试（assert 这些参数不在可调列表） |
| 单次调整步长**必须**受限（±10% 或固定小步） | EvolutionEngine 单元测试（注入大步长建议，assert 被拒绝） |
| 调整后信号恶化**必须**自动回滚 | EvolutionEngine 集成测试（注入恶化信号，assert 参数还原） |
| 连续 3 次恶化**必须**停止该参数自动调整 | EvolutionEngine 集成测试 |
| 所有调整**必须**进 audit.jsonl（含 before/after/reason/signal） | EvolutionEngine 单元测试 + audit 文件 schema 校验 |
| `[evolution] enabled = false` **必须**让所有参数回内置默认 | core 启动流程单元测试 |
| tuning 日志 signal 段**禁止**含 prompt/代码明文 | `shared.sanitize()` 强制 + 单元测试（注入含 secret 的 signal，assert 脱敏） |
| 进化**禁止**跨用户聚合（只读本机信号） | EvolutionEngine 代码无任何网络/多用户读取路径（code review + ESLint） |

### 15.8 事件（telemetry，本地）

| 事件 | 说明 |
|---|---|
| `evolution.adjusted` | 某参数被调整（`{ namespace, param, before, after, reason }`） |
| `evolution.rolled_back` | 恶化自动回滚（`{ namespace, param, reason }`） |
| `evolution.disabled` | 用户关闭进化或某 namespace |
| `evolution.confirmation_requested` | 累计大调整弹窗（`{ namespace, param, deviation_pct }`） |
| `evolution.observation` | 采样窗口聚合信号（采样发，每窗口 1 次） |

### 15.9 配置（`config.toml [evolution]`）

```toml
[evolution]
enabled = true                              # 全局开关
namespaces = ['context', 'router', 'retry', 'tool-timeout']  # 启用的 namespace（细粒度）
sample_window = 20                          # 采样窗口大小（事件数）
max_deviation_pct = 30                      # 累计偏离默认超此值需人确认
rollback_on_worsen = true                   # 恶化自动回滚（强烈不建议关）
worsen_streak_limit = 3                     # 连续恶化 N 次停止自动调整
```

### 15.10 里程碑

- **L1**：无进化系统（参数用内置默认）
- **L2**：EvolutionEngine 核心模块 + **ContextPolicy 首个进化点**（compaction_threshold/target_ratio/keep_recent 自调优）+ `apollo evolution show/rollback` CLI + Memory(scope=tuning) 写入
- **L3**：扩展 Router / Retry / Tool timeout 进化点 + 累计大调整弹窗确认
- **L4**：进化效果 dashboard（`apollo evolution dashboard` 展示参数随时间变化曲线）+ Memory(scope=tuning) 完整召回 + 用户偏好深度学习

### 15.11 跨节落地

- **§8b ContextPolicy**：首个进化点，§8b.14 详述接入
- **§3.7 Router / §3.9a Retry**：L3 进化点，参数可调
- **§4.3 Tool timeout**：L3 进化点
- **§5 Sandbox**：仅观察，不接入（安全边界冻结）
- **§6.12 Memory**：`scope: 'tuning'` 作为 Layer A 载体，复用现有存储/召回/脱敏/hook
- **§11 CLI**：`apollo evolution <show|rollback|enable|disable>` 命令族
- **§12.5b RFC**：进化护栏参数变更（§15.5）需 RFC + 人审批
- **§12.6b AI-native 协作**：进化系统的"人在环检查点"（累计大调整确认）是 AI-native 范式下人保留决策权的体现

---

## 变更日志

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-08-01 | §15 v1（r10） | 新增「自我进化框架」整节：响应用户原则「核心智能层需不断自我进化」。双层记忆模型（Memory scope=tuning 存模式 + tuning/*.jsonl 存参数）+ 通用进化循环（Observation→Hypothesis→Adjustment→Validation）+ 进化接入点矩阵（Context L2 / Router+Retry+Tool L3 / Sandbox 观察 only）+ 安全护栏（安全参数冻结 / 步长受限 / 恶化回滚 / 可关闭 / 审计完整 / 不跨用户 / 脱敏）+ 人机协作（小幅静默 / 大调整确认）+ 边界清单 + 配置 + 里程碑 + 跨节落地。 |
