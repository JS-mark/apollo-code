# 经验库（Lessons Learned）

> **维护规则**（监控/主 agent 必须遵守）：
> 1. 条目三段式：**问题 → 根因 → 可执行规则**；规则必须是可执行指令，不是口号；单条 ≤15 行。
> 2. 只追加/更新，不删除历史正文；同根因已存在则更新原条目（补实例与日期），不新建。
> 3. 状态：`active`（生效）/ `promoted-candidate`（建议晋升为治理文档条款，由主 agent 提案、BDFL 批准）/ `obsolete`（规则失效，保留正文）。
> 4. 条目总数 >40 时由主 agent 提议归档 obsolete 项。

---

### LL-1 证据行号会漂移，以符号名为准
- 类别：验证陷阱｜日期：2026-08-15｜来源：REVIEW-r11 审计
- 问题：审计/验收引用的 `file:line` 在代码或文档修订后失效，导致误报"问题不存在"或"修复不成立"。
- 根因：行号是快照性证据，符号名才是稳定锚点。
- 规则：任何结论的代码引用必须 `file:line` + 符号名双锚定；复验时先按符号定位再取新行号，行号变了但符号在 ≠ FAIL。
- 状态：active

### LL-2 两路独立核查结论冲突时必须裁定，不得择优引用
- 类别：流程缺口｜日期：2026-08-15｜来源：REVIEW-r11（"500 calls/turn" 语义两路核查不一致）
- 问题：两个并行核查对同一事实给出不同结论（配额是 per-turn 还是 per-process），若直接择优引用会埋下错误结论。
- 根因：浅层 grep（只核默认值）与深层 grep（追接线路径）深度不同，结论可信度不同但表面上都是"有证据"。
- 规则：验收中遇证据冲突，必须用可运行的专项测试裁定，裁定前该标准记 ⚠️ 并在报告 Ambiguity 节说明；禁止因"某一路有 file:line"就采信。
- 状态：active

### LL-3 任务的"完成"必须包含文档同步，改码不同步文档=未完成
- 类别：根因分析｜日期：2026-08-15｜来源：REVIEW-r11（spec/ADR/治理文档三层分裂的系统性根因）
- 问题：本仓库曾出现"主进程机制已实现有测试，但 bridge 未暴露、CLI 未接线、spec 声称已上线"的多层不同步（PLUGIN-PROVIDER-r1），最终导致 24 条治理文档条目失实。
- 根因：任务验收只看代码产出，文档同步（spec 卷 / 16-capability-traceability / 治理文档）从未进入任何人的 DoD。
- 规则：任何 REM 的验收报告必须有"文档同步检查"节；16-traceability 未更新视为 P1 缺陷；执行 agent 的 DoD 必须含文档同步项。
- 状态：active

### LL-4 声明完成 ≠ 验证完成：一切"已实现"都要现场取证
- 类别：验证陷阱｜日期：2026-08-15｜来源：REVIEW-r11（`session.on` no-op、bridge 假实现、`observe()` 零调用）
- 问题：类型定义、SDK 签名、spec 声明都"存在"，但运行时是 no-op/抛错/零调用方——按声明验收会全部误判为完成。
- 根因：存在性检查（符号在不在）与行为验证（调用路径通不通）是两个层次，前者廉价后者昂贵，偷懒会全部停在前者。
- 规则：验收必须含至少一条动态证据（运行测试/命令的真实输出）或调用链证据（调用方 grep 非空）；只有静态存在性证据时 verdict 最高只能给 PARTIAL。
- 状态：active

### LL-5 worktree 不能放 /tmp：macOS realpath 守卫会让部分测试预存失败
- 类别：环境陷阱｜日期：2026-08-16｜来源：r13 批次 1（REM-54 验收发现）
- 问题：git worktree 建在 `/tmp/apollo-rem/*` 时，`packages/shared/path-guard` 与 `apps/cli` 共 37 例测试预存失败（干净 base 上可复现），易被误判为 REM 引入的回归。
- 根因：macOS `/tmp` 是 `/private/tmp` 的 symlink，`fs.realpath(PWD)` 与字符串 cwd 不一致，触发仓库的 path-guard 安全守卫（`--cwd` 归一化规则 W6）。
- 规则：并行执行用的 worktree 一律放真实路径目录（如 `~/apollo-worktrees/`），禁用 `/tmp`；验收时若见 path-guard/cli 失败，先在干净 base 复现排除环境因素再定性。
- 状态：active

### LL-6 执行 agent 的 DoD 必须含仓库 CI 等价命令（format/lint/跨平台），且 lint error 提取要用 `x` 标记
- 类别：流程缺口｜日期：2026-08-17｜来源：r13 批次 1 CI 修复（4/5 PR 首轮 check 失败）
- 问题：批次 1 五个 PR 中四个首轮 CI 失败：① 全部挂 quality 第一步 `pnpm format:check`（agent 没跑 oxfmt）；② #111 挂 ts (windows)（实现只验了 mac：win32 分隔符/USERPROFILE/盘符 resolve 差异）；③ #112/#113 挂 lint 真错误（悬浮 Promise / 未用参数）。
- 根因：执行 agent 的任务卡 DoD 只写了「test + typecheck 绿」，未含 `pnpm format`、`pnpm lint`，也没有 Windows 语义意识；本地验证 lint error 时误把 warning 帮助文本当 error（oxlint 输出中 `x` 才是 error、`!` 是 warning）。
- 规则：① 执行 agent 任务卡 DoD 固定加：`pnpm format && pnpm turbo run build && pnpm lint`（type-aware lint 依赖先 build 出 dist 声明）+ 受影响包 test；② 路径/权限/IPC 类代码必须考虑 win32 差异（分隔符、HOME vs USERPROFILE、无盘符绝对路径的 resolve、8.3 短名）；③ lint 结果判定以 `grep "^  x "` 提取，CI 为最终裁决；④ 重负载并发类测试（如 storage 的 20 轮文件锁合并）在满载 Windows runner 上需显式 `it(..., 30_000)` 超时。
- 状态：active
