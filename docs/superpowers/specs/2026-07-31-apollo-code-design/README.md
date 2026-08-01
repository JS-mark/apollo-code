# Apollo Code — 设计文档 (Design Spec)

> **状态**：🚧 In Progress（brainstorming 阶段，随分节推进滚动补全）
> **日期**：2026-07-31
> **作者**：Mark + Claude
> **相关**：[AGENT.md](../../../../AGENT.md) · [CLAUDE.md](../../../../CLAUDE.md)

---

## 摘要 (TL;DR)

Apollo Code 是 claude-code 的开源平行实现：**多模型后端的终端 AI 编码 CLI**。

| 维度          | 决策                                                                    |
|---------------|-------------------------------------------------------------------------|
| 定位          | claude-code 开源平行实现，不绑定厂商                                     |
| Provider 策略 | 多 Provider 插件化 + 中间路由层（fallback / role-based）                  |
| MVP 范围      | L4：对话 + 工具 + 权限 + MCP + 子 Agent + Skill/Plugin/Hooks（分阶段落地） |
| 终端 UI       | Ink（React for CLI）                                                      |
| 安全          | 权限弹窗 + **Rust 沙箱**（fork codex 底座；**L1: mac/linux 4 target 硬约束；L2 补齐 Windows Tier1 + Linux musl 至 8 target**；三产物均独立二进制） |
| Rust 面积     | 沙箱 + 搜索/AST（ripgrep + tree-sitter）+ FS diff/tokenize，其他 TS；**三产物均独立二进制（r9）** |
| 存储          | 纯文件（JSONL 会话 + toml 配置）                                          |
| 分发          | npm 包 + 平台化 optionalDependencies + 单文件二进制并行                 |
| 构建          | rolldown + Vite 8 + Cargo                                               |
| 遥测          | **默认本地文件**，OTel 网络上报显式 opt-in                               |
| 开发范式      | **AI 完全开发 + 人定方向**（spec 即可执行契约；详见 [§12.6b](./12-open-governance.md)） |
| 自我进化      | 贯穿性反馈闭环（[§15](./15-self-evolution.md)）：双层记忆 + 各能力节点自调优 + 安全边界冻结 + 人可审计/回滚 |

---

## 目录（AI / 编辑器可跟进的相对路径）

原始整文档已按顶级章节 §1–§14 拆分到本目录下的独立模块文件。链接使用相对路径 Markdown，
在 GitHub、VS Code、绝大多数 IDE 与 AI 阅读器中均可点击/跳转。

| §   | 章节                            | 文件                                                | 行数  |
|-----|---------------------------------|------------------------------------------------------|-------|
| 1   | 仓库布局 (v3, review 修正版)     | [`01-repo-layout.md`](./01-repo-layout.md)           | 249   |
| 2   | 核心数据模型与 Agent Loop        | [`02-agent-loop.md`](./02-agent-loop.md)             | 354   |
| 3   | Provider 抽象层 & Router 策略    | [`03-provider-router.md`](./03-provider-router.md)   | 426   |
| 4   | 工具体系与权限                   | [`04-tools-permissions.md`](./04-tools-permissions.md) | 264 |
| 5   | Rust 侧车（沙箱 + 搜索 + FS）    | [`05-rust-sidecar.md`](./05-rust-sidecar.md)         | 264   |
| 6a  | Skill / Plugin / MCP / Hooks — 核心插件架构（6.1–6.4） | [`06a-plugins-core.md`](./06a-plugins-core.md)     | 372   |
| 6b  | PromptComposer + 插件生命周期（6.5–6.11）              | [`06b-prompt-composer.md`](./06b-prompt-composer.md) | 500  |
| 6c  | Memory 系统（长期记忆，6.12）                          | [`06c-memory-system.md`](./06c-memory-system.md)   | 292   |
| 7   | 终端 UI (Ink)                    | [`07-terminal-ui.md`](./07-terminal-ui.md)           | 182   |
| 8   | 会话与配置存储                   | [`08-session-config.md`](./08-session-config.md)     | 291   |
| 8b  | 上下文管理（ContextPolicy，r9 新增） | [`08b-context-policy.md`](./08b-context-policy.md) | ~280 |
| 9   | 构建 / CI / 分发                 | [`09-build-ci-dist.md`](./09-build-ci-dist.md)       | 163   |
| 10  | 里程碑 L1 → L4                   | [`10-milestones.md`](./10-milestones.md)             | 100   |
| 11  | CLI 命令树设计                   | [`11-cli-commands.md`](./11-cli-commands.md)         | 290   |
| 12  | 开源治理                         | [`12-open-governance.md`](./12-open-governance.md)   | 141   |
| 13  | 文档站 IA + 官网首页             | [`13-docs-site.md`](./13-docs-site.md)               | 220   |
| 14  | 首次运行 UX / Onboarding         | [`14-onboarding.md`](./14-onboarding.md)             | 210   |
| 15  | 自我进化框架（r10 新增）          | [`15-self-evolution.md`](./15-self-evolution.md)     | ~230  |

### 附属专题文档

| 主题                                            | 文件                                                 | 说明                                                                 |
|-------------------------------------------------|------------------------------------------------------|----------------------------------------------------------------------|
| 跨平台沙箱兼容性白皮书 (SANDBOX-COMPAT r1)      | [`SANDBOX-COMPAT-r1.md`](./SANDBOX-COMPAT-r1.md)     | L1: 4 target × 3 crate = 12 平台包；L2: 8 target × 3 = 24 平台包；5 ADR；per-target Tier / escape 矩阵 |
| 插件 Provider 扩展白皮书 (PLUGIN-PROVIDER r1)   | [`PLUGIN-PROVIDER-r1.md`](./PLUGIN-PROVIDER-r1.md)   | ProviderRegistry 端点；3 决策（sandbox stream/main 注入凭据/显式进 Router）；凭据分层；边界 B1-B8 + 风险 S1-S5 |
| 设计评审报告 (REVIEW r6)                        | [`REVIEW-r6.md`](./REVIEW-r6.md)                     | P0/P1/P2/P3 + 功能缺口清单（14 节全评审）                            |
| 设计评审报告 (REVIEW r7)                        | [`REVIEW-r7.md`](./REVIEW-r7.md)                     | 复审：核对 r6 落地状态 + 新发现 P0×1/P1×4/P2×5/P3×4（含配置注入、平台包 18v24 矛盾、Memory 模型面工具缺失） |
| 设计评审报告 (REVIEW r8)                        | [`REVIEW-r8.md`](./REVIEW-r8.md)                     | 全量一致性复审：补审治理文件 + 系统扫描（§4.13 幻影引用 / 6-8 target 语义 / 事件数 / priority 槽 / 里程碑对齐），P0/P1 全清，P2 文档矛盾全清 |
| 设计评审报告 (REVIEW r9)                        | [`REVIEW-r9.md`](./REVIEW-r9.md)                     | 「设计本身好不好」独立复审：范围/复杂度/context 智能层/stream 计费/@UX/JSONL/codex 依赖等系统性短板 + 10 项处置落地（Rust 全二进制化 + L1 砍范围 + ContextPolicy 补齐 + @ 统一 picker + JSONL 分段 + stream 复用 + hook kv + provider-plugin L3） |
| 设计评审报告 (REVIEW r10)                       | [`REVIEW-r10.md`](./REVIEW-r10.md)                   | 三原则落地：AI-native 开发范式（§12.6b）+ 自我进化贯穿框架（§15 双层记忆 + 各节点自调优 + 安全边界冻结）+ Context 透明可控（CLI + TUI 面板） |
| L1 发版前可勾选清单 (r10.1 新增)               | [`RELEASE-CHECKLIST-L1.md`](./RELEASE-CHECKLIST-L1.md) | L1 MVP 发版闸门单一视图：把散落 §3-§14 各章的 L1 强制点 + DoD + §9.4 CI matrix（4 native + 4 escape）+ §10 完成闸门 8 项汇成可勾选清单；符合 §12.6b「spec 即 AI 可执行契约」 |

> 各文件内保留原章节编号（如 `## §1`、`### 1.1`），可与 git 历史里的旧单文件版本一一对应。

---

## 阅读顺序建议

- **想快速了解全貌** → 从 §1 → §2 → §10 走一遍。
- **想理解运行时/内核** → §2 (Agent Loop) → §3 (Provider) → §4 (Tools) → §5 (Rust)。
- **想理解扩展生态** → §6a → §6b → §6c → §11 (CLI)。
- **想理解落地/交付** → §7 → §8 → §9 → §14。
- **想参与共建** → §12（治理）→ §10（里程碑）。

---

## 章节间交叉引用速查

- **§1 布局** 是 §3/§4/§5/§6 的目录归宿参照
- **§2 Agent Loop** 定义了 §3 Router、§4 Tool、§6 Hook 的调用契约
- **§3 Router** ↔ **[PLUGIN-PROVIDER-r1](./PLUGIN-PROVIDER-r1.md)** ↔ **§6 插件**：插件 provider 经 ProviderRegistry 进 Router 候选池（受控扩展，不破坏 Router 强制）
- **§4 Tool** 与 **§5 Rust 沙箱** 通过 §5.6 `native-bridge` 对接
- **§5 Rust 沙箱** ↔ **[SANDBOX-COMPAT-r1](./SANDBOX-COMPAT-r1.md)** ↔ **§9.4 CI matrix** ↔ **§10 L1 闸门** ↔ **§14.3b Tier 披露** 形成沙箱一等公民闭环
- **§6 Plugins** 与 **§4 Tool 注册**、**§8 Config**、**§11 CLI** 均有交叉
- **§10 里程碑** 与各章节末尾的"里程碑"小节形成 vertical/horizontal 交叉视图

---

## 修改约定

- 结构性调整（新增/删除章节、跨节改动）→ 更新本 README 目录与"章节间交叉引用"。
- 章节内演进（在已有章节内改进）→ 直接改对应模块文件即可，无需回改本 README。
- 每次实质性变更请在文件头保留 `> **状态**` / `> **日期**` 类的元数据行（章节文件继承主文档头信息即可，也可在文件顶部按需追加子状态）。

---

## 归档

- 单文件旧版本已归档为 `../2026-07-31-apollo-code-design.archived.md`（如仍存在，仅供历史查阅，请勿再编辑）。
