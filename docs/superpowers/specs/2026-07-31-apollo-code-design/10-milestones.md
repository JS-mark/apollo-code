> ↩ [返回索引 (README)](./README.md) · ← [上一章: §9 构建 / CI / 分发](./09-build-ci-dist.md) · [下一章: §11 CLI 命令树](./11-cli-commands.md) →

---

## §10 里程碑 L1 → L4

本节是 §3-§9 各节末尾里程碑的**总视图**，每个 L 阶段可作为一个可发布版本。

### L1（MVP —— 可用的对话 + 工具 + mac/linux 4 target 沙箱底座）

**目标**：Anthropic + 7 个内置工具 + 权限弹窗 + 会话持久化 + **mac/linux 4 target 沙箱可用**（Windows/musl 推 L2）。安全可用于自己开发。

- ✅ apps/cli 单 bin + Ink UI（消息流 + 权限弹窗 + slash 命令 + `@` alias）
- ✅ provider-kit + provider-anthropic + SingleProviderRouter
- ✅ core Runner + SessionState（immer）+ 17 事件（含 `session.resumed`）
- ✅ tool-kit + tools: Read / Write / Edit / Bash / Grep / Glob / Todo
- ✅ permission 决策链完整 + auto-allow 保守规则
- ✅ **ContextPolicy: SlidingWindowPolicy**（[§8b](./08b-context-policy.md)，r9 新增补齐）
- ✅ native-bridge + apollo-sandbox **mac/linux 4 target 全落**（**fork codex 沙箱三件套**：macOS Full seatbelt / Linux Full bundled-bwrap+seccomp 或 Partial landlock fallback）+ apollo-search/fs **独立二进制 worker**（r9 架构变更）
- ✅ auth（keychain + env）+ http-kit
- ✅ storage: config.toml + credentials + JSONL sessions（**分段加载**，[§8.2b](./08-session-config.md)）+ telemetry 本地
- ✅ 平台包 optionalDependencies 挂载 **12 包全发**（4 target × 3 crate；L2 扩 24 包）
- ✅ CI: typecheck / test / build + **4 native + 4 sandbox-escape + license-check + bwrap-digest** 全绿
- ✅ **codex workspace 依赖全 vendor 跑通**（12 crate，workspace 名 `apollo-sandbox-vendor`）
- ✅ Onboarding 首次运行沙箱 Tier disclosure（mac/linux 4 target；Windows/musl L2 起接入）
- ⛔ 无 Skill / Plugin / MCP / subagent（推 L2/L3）
- ⛔ 无 fallback router（推 L3）
- ⛔ **Windows Tier 1/2/3 → L2/L2/L3**（r9 调整：Windows 从 L1 推到 L2）
- ⛔ **Linux musl × 2 target → L2**（r9 调整：musl 从 L1 推到 L2）

**Definition of Done**：能用 `apollo` 对着 Anthropic 完成一个真实的编码任务（改文件 + 跑测试 + 提 PR），全程权限弹窗可控；**mac/linux 4 target** 的 escape 测试基础用例全部通过，任何降级都在 UI 显式披露。

### L2（多 provider + 上下文管理 + 扩展基础 + 平台扩面至 8 target）

**目标**：OpenAI 接入 + 上下文自动压缩（Summary）+ Skill 机制 + **平台扩面（Windows Tier1 + musl，CI 扩至 8 target）**。

- ✅ provider-openai + 跨 provider 一致性测试
- ✅ **context: SummaryPolicy**（[§8b.5](./08b-context-policy.md)，含失败回退 Sliding）+ 插件 contributePolicy 扩展点
- ✅ MultiEdit + Backups 机制
- ✅ storage: `apollo resume` + `apollo restore`
- ✅ skills-runtime（progressive disclosure）+ PromptComposer 完整
- ✅ apps/docs 首版 + TypeDoc 集成 + 部署 GitHub Pages
- ✅ Renovate + changesets 完整
- ✅ 附件粘贴（图片）+ vision 支持
- ✅ **平台扩面**：Windows Tier 1 (Job + Restricted Token) + Linux musl × 2 target 落地；平台包 12 → 24；CI 扩至 8 native + 8 escape
- ✅ **自我进化系统 L2 首接入**（[§15](./15-self-evolution.md)）：EvolutionEngine + ContextPolicy 自调优（首个进化点）+ `apollo evolution show/rollback` CLI + Memory(scope=tuning)
- ✅ **Context 透明可控**（[§8b.13](./08b-context-policy.md)）：`apollo context show/diff/keep/compact/policy` CLI + TUI `/context` 面板
- ✅ **Windows Sandbox Tier 2**（AppContainer + ACE）落地 + escape 基础用例全通
- ✅ Windows authenticode 自签 + macOS notarize 上线；发版清单区分 Full / Partial / Weak Tier
- ⛔ 无 Plugin / MCP（L3）

**Definition of Done**：跨长会话（100+ turn）不炸，用户能装 Skill 定制行为；**8 target**（含 Windows/musl）escape 全通。

### L3（扩展生态 + 路由智能）

**目标**：MCP / Plugin / Task subagent 全上线；FallbackRouter；错误分类完整；**provider-plugin header-template（r9 提前）**。

- ✅ mcp-client（stdio + http/sse）
- ✅ plugin-runtime + plugin-sdk（发 npm）
- ✅ **provider-plugin（header-template 模式，r9 提前到 L3，见 [PLUGIN-PROVIDER-r1 §P12](./PLUGIN-PROVIDER-r1.md)）**：支持 vLLM/DeepSeek 等非四大厂 provider 经插件注册
- ✅ JSBridge 完整 API 表面（apollo.tools/hooks/commands/prompt/session/fs/exec/http/ui/storage/config/log/**hook.kv**[r9]）
- ✅ subagent + Task tool（3 层深度）
- ✅ FallbackRouter + 冷却机制
- ✅ apollo-fs（diff + token 计数）+ AST 查询
- ✅ **Windows Sandbox Tier 3**（WFP user-mode 网络过滤）投产 + AWS Graviton 真机抽检接入
- ✅ 沙箱违规日志 + telemetry 事件面板（Tier / escape 拒绝率 / 平台探针 ABI）
- ✅ **自我进化扩展**（[§15](./15-self-evolution.md)）：Router / Retry / Tool timeout 进化点接入 + 累计大调整弹窗确认
- ⛔ 无 Gemini / Ollama（L4）
- ⛔ 无独立二进制（L4）

**Definition of Done**：社区能开发第一个真实 plugin（走全流程：写 → 打包 → 发 npm → 用户 install → 权限弹窗 → 运行）。

### L4（生态成熟 + 高级路由）

**目标**：Gemini / Ollama / RoleRouter / WebFetch。

- ✅ provider-gemini + provider-ollama
- ✅ RoleRouter（planner/coder/reviewer 分派）
- ✅ WebFetch + WebSearch tools（网络 permission）
- ✅ `--json` 结构化输出模式
- ✅ 独立二进制分发（bun compile / pkg）
- ✅ Homebrew tap
- ✅ 主题 + 插件 UI 扩展点
- ✅ **Authenticode EV 证书**迁移（替换 L2 自签）+ Windows Store 兼容
- ✅ **8 target × 3 Tier**（Full/Partial/Weak）状态矩阵稳定公示
- ⛔ CostAwareRouter / SemanticRouter → v2
- ⛔ Auto-update → v2
- ⛔ 中央 Plugin Registry → v2

**Definition of Done**：功能完整对齐 claude-code，多 provider 无缝切换，社区 plugin 生态形成。

### 时间预估（粗，r10 校准为 AI-native 口径）

> **r10 范式校准**：本项目由 AI 完全开发、人定方向（[§12.6b](./12-open-governance.md#126b-ai-native-开发协作约定r10-新增)）。下表的「工作量」按 **AI 迭代轮数**（brainstorm→plan→TDD→PR→人审批→merge 一轮）口径，非真人墙钟工时。实际墙钟时间取决于人审批检查点（§12.6b）的响应速度——AI 写代码快，但人在环检查点（安全边界 / provider / 进化护栏 / RFC 项）串行。

| 阶段 | 预估 AI 迭代轮数  | 备注                                                       |
|------|---------------------|------------------------------------------------------------|
| L1   | **8-12 轮**（r10） | mac/linux 4 target + fork codex 沙箱底座 + search/fs 改独立二进制 worker（r9）+ 多个强制点测试需迭代稳定 |
| L2   | 8-10 轮            | provider + context Summary + 平台扩面（Windows/musl）+ 进化系统 L2 首接入（ContextPolicy 自调优） |
| L3   | 12-15 轮           | 扩展系统复杂（MCP/Plugin/subagent）+ Windows Tier 3 + 进化扩展 Router/Retry/Tool + provider-plugin header-template |
| L4   | 5-8 轮             | 额外 provider + polishing + EV 证书迁移 + 进化 dashboard |

**总计约 33-45 轮 AI 迭代**到功能完整（r10 估算）。相比 r9 的「单人 3-4 月」口径，本口径承认：AI 执行快，但 (a) 强制点测试需多轮迭代稳定；(b) 人在环检查点串行；(c) 跨平台沙箱 + codex fork 适配的不确定性高（每轮可能撞到 API 深耦）。

> ⚠️ **估算前提（r10 更新）**：L1 从 r9 的 3-4 周（单人）改为 **8-12 轮 AI 迭代**——核心原因是 r10 明确「AI 完全开发」范式后，时间不再用墙钟周数衡量（AI 可 7×24 写代码，但人审批 + 测试稳定是瓶颈）。主要工作是 **vendor codex 三件套 + 12 workspace 依赖 + 切断耦合 + escape 测试对接 + tier 探测适配 + search/fs worker 二进制化**。若 codex workspace 依赖剥离遇到意外的 API 深耦，L1 现实取值 12-15 轮。**沙箱是产品硬约束（[SANDBOX-COMPAT-r1 §S1](./SANDBOX-COMPAT-r1.md)），L1 不允许绕过 mac/linux 4 target 底座**。设计文档不承诺发布日期，实际以主分支 changeset 为准。

### 每阶段"完成"闸门

每个 L 阶段完成前必须过：

1. ✅ 所有 §4 边界规则未被违反（CI + ESLint 强制）
2. ✅ **全 CI matrix 通过**：typecheck / test / build + **L1: 4 native target + 4 sandbox-escape（mac/linux）；L2+: 扩至 8 native + 8 escape** 全绿（详见 [§9.4](./09-build-ci-dist.md#94-ci-matrix)）
3. ✅ 该阶段所有 "Definition of Done" 手动验证
4. ✅ AGENT.md / CLAUDE.md 同步更新
5. ✅ 变更走 changeset，发到 npm（**L1: 12 平台包；L2+: 24 平台包**）
6. ✅ apps/docs 该阶段新能力需要把文档更新
7. ✅ 至少一次真实使用（dog-fooding，用 apollo 开发 apollo）
8. ✅ **release notes 明确标注**每 target 的 Sandbox Tier（Full/Partial/Weak）+ escape.pass_ratio，任何降级须有 issue 追踪

---

### L1 收尾工具：Release Checklist

L1 发版前，请按 [`RELEASE-CHECKLIST-L1.md`](./RELEASE-CHECKLIST-L1.md) 逐项勾选——它把本节 14 条交付项 + 8 项完成闸门 + 散落 §3-§14 各章的 L1 强制点（§4.11 / §5.10 / §8.8 / §8b.9 / §3.10 …）+ §9.4 CI matrix（4 native + 4 escape）+ DoD 手动验证 + dog-fooding 汇成**单一可勾选清单**。

这是 §12.6b「spec 即 AI 可执行契约」的具体落地：AI 执行 L1 收尾时跑此 checklist 即可确认所有强制点落地，无需翻 10+ 个文件拼清单。签收由 BDFL（人）完成。

