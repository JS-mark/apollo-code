> ↩ [返回索引 (README)](./README.md) · ← [上一章: §3 Provider & Router](./03-provider-router.md) · [下一章: §5 Rust 侧车](./05-rust-sidecar.md) →

---

## §4 工具体系与权限

本节定义 `packages/tool-kit`（契约）、`packages/tools`（内置工具）、`packages/permission`（决策层）的边界。

### 4.1 设计目标

| 目标                    | 具体含义                                                                     |
|-------------------------|------------------------------------------------------------------------------|
| **工具是一等公民**      | 所有能改变世界的操作走 Tool，包括内置、MCP、插件贡献的。                       |
| **权限声明式**          | Tool 静态声明 `PermissionSpec`；用户配置 allowlist；运行时决策 + 弹窗。         |
| **沙箱兜底**            | 副作用系工具（Bash / Write / Edit）必须过 Rust sandbox 或 explicit override。   |
| **可扩展**              | 内置 / MCP / 插件三种来源都注册到同一 `ToolRegistry`。                          |
| **可撤销 / 可审计**     | 破坏性操作应可回溯（backup / dry-run）。                                        |
| **失败隔离**            | 单 tool 出错不炸 session（转 `tool_result.isError=true`）。                     |

### 4.2 Tool 契约（tool-kit）

```ts
export interface Tool<Input = unknown> {
  readonly name: string                             // 唯一，全局 registry key
  readonly description: string                      // 传给模型
  readonly inputSchema: JSONSchema                  // JSON Schema，序列化给 provider
  readonly outputHint?: string                      // 补充告诉模型输出形态

  /** 声明此工具在给定 input 下需要什么权限 */
  permissionSpec(input: Input): PermissionSpec

  /** 是否只读（不产生副作用）。用于 UI 提示 + 自动批准策略 */
  readonly readonly?: boolean

  /** 执行超时，默认 60s */
  readonly timeoutMs?: number

  /** 并行安全性：Runner 决定并行度时参考 */
  readonly parallelSafe?: boolean                   // 默认 true

  /** 主执行 */
  invoke(input: Input, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolContext {
  readonly abortSignal: AbortSignal
  readonly session: SessionSnapshot                 // 只读，含 cwd / turnId
  readonly native: NativeBridge                     // 走沙箱的入口
  readonly logger: Logger                           // 写 telemetry
  readonly ui: ToolUiPort                           // 请求用户输入（少用；主要靠 permission）
}

export interface ToolResult {
  content: ContentPart[]                            // 复用 §2 的中性表示
  isError?: boolean
  meta?: ToolResultMeta
}

export interface ToolResultMeta {
  durationMs: number
  bytesRead?: number
  bytesWritten?: number
  filesTouched?: string[]                           // storage 侧可用于审计
  costImpact?: 'safe' | 'moderate' | 'high'         // UI 展示
}
```

**关键约定**：
- Tool **不感知** provider（结果是中性 `ContentPart[]`）
- Tool **不直接** 调 permission，Runner 层统一调
- Tool **必须** 尊重 `abortSignal`（长任务定期检查）
- Tool 抛异常 = 违规。所有错误应转 `{ isError: true, content: [{ type: 'text', text: '...' }] }`

### 4.3 内置工具清单（packages/tools）

| 名字        | 类型     | 描述                        | readonly | 沙箱 | 依赖 native            |
|-------------|----------|-----------------------------|----------|------|------------------------|
| `Read`      | 文件读   | 读取指定文件片段            | ✅       | 只读白名单 | apollo-fs (可选)       |
| `Write`     | 文件写   | 创建/覆写文件                | ❌       | ✅   | apollo-fs (diff 显示)  |
| `Edit`      | 文件改   | 精确字符串替换               | ❌       | ✅   | apollo-fs              |
| `MultiEdit` | 文件改   | 批量 Edit（原子）            | ❌       | ✅   | apollo-fs              |
| `Bash`      | 命令执行 | shell 命令                   | ❌       | **必须** | apollo-sandbox    |
| `Grep`      | 搜索     | ripgrep（Rust addon）        | ✅       | 只读 | apollo-search          |
| `Glob`      | 搜索     | 文件通配                    | ✅       | 只读 | fast-glob (JS fallback) |
| `Todo`      | 状态     | Todo 列表（session-scoped） | ✅       | 无   | -                      |
| `Task`      | 分派     | 启动 subagent               | ❌       | 无（子 agent 各自管）| subagent 包             |
| `Skill.activate` | 元操作 | 激活一个 Skill（注册其 prompt fragment）；inputSchema `{ name: string }`；auto-allow（只读副作用） | ✅ | 无 | skills-runtime（L2） |
| `Memory.recall` / `Memory.read` / `Memory.list` | 记忆读 | 召回/读全文/列表（§6.12.2a） | ✅ | 无 | memory-runtime（L2/L3） |
| `Memory.write` / `Memory.update` / `Memory.delete` | 记忆写 | 写/改/删 memory（过脱敏 hook + permission） | ❌ | 无 | memory-runtime（L2） |
| `WebFetch`  | 网络     | 抓 URL（可选，v2）           | ✅       | 允许 net | http-kit               |
| `WebSearch` | 网络     | 搜索引擎（v2）               | ✅       | 允许 net | 各家 API              |

**MVP L1** 只上：`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `Todo`。

> ★ **自我进化接入（r10）**：各 tool 的 `timeoutMs` 可经 [§15.4](./15-self-evolution.md) 自调优；调整记 `~/.apollo/tuning/tool-timeout.jsonl`。观察信号：tool 超时频率 / 超时后用户重试频率。落地里程碑：L3。安全护栏：timeout 上限不可超过 300s（防进化让恶意 tool 长期占用）。

**Task / WebFetch / WebSearch** 分 L2-L4 逐步加。

### 4.4 权限模型（packages/permission）

```ts
export interface PermissionSpec {
  fs?: {
    read?: string[]                                 // 具体路径或 glob
    write?: string[]
  }
  bash?: {
    command: string                                 // 完整命令，permission 侧展示 + 匹配
  }
  net?: {
    url: string
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  }
  env?: {
    read?: string[]                                 // 环境变量名
  }
  custom?: Record<string, unknown>                  // 插件扩展点（少用）
}

export interface PermissionRequest {
  toolName: string
  spec: PermissionSpec
  input: unknown                                    // 原始 input，用于弹窗展示
  session: SessionSnapshot
  attempt: number                                   // 首次 / 二次（用户已改过决策）
}

export type PermissionDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session' }                       // 加入 SessionState.permissionCache
  | { kind: 'allow-project' }                       // 写入 <cwd>/.apollo/permissions.toml
  | { kind: 'allow-forever' }                       // 写入 ~/.apollo/permissions.toml
  | { kind: 'deny' }                                // 单次拒绝
  | { kind: 'deny-forever' }                        // 全局黑名单
```

**决策链**（从上到下，任一命中即返回）：

```
permission.request(req):
  1. 项目黑名单？→ deny
  2. 全局黑名单？→ deny
  3. SessionState.permissionCache 命中？→ allow
  4. 项目 permissions.toml 命中？→ allow
  5. 全局 permissions.toml 命中？→ allow
  6. 内置 auto-allow 规则（如 Read 到 cwd 内、Bash 白名单命令）？→ allow
  7. --dangerously-skip-permissions 标志？→ allow（写日志）
  8. 无匹配 → 弹窗询问用户 → 结果按 decision 写入相应存储
```

**auto-allow 内置规则**（保守，用户可关）：
- `Read` 目标在 `cwd` 内 → allow-session
- `Grep` / `Glob` 在 `cwd` 内 → allow-session
- `Bash` 命令匹配 `^(ls|pwd|git status|git diff|git log|node --version|...)` 只读子集 → allow-once
- 其它一律弹窗

**弹窗触发**：`permission` 内部持有 `PromptHandler`（由 `apps/cli` 注入 ui 实现，见 §1.5）。permission 内部**串行队列**弹窗，一次只显示一个（防刷屏，见 §2.5）。

### 4.5 PermissionSpec ↔ 沙箱执行

**核心决策**：**permission 是策略层，sandbox 是执行层**。permission 允许了不代表就直接执行，仍要过 sandbox（如果工具声明了 sandbox 需求）。

流程：

```
Tool.invoke:
  1. Tool 内部拿到 input，构造 native call
  2. native.exec({ command, permissions: { fs: {...}, bash: {...} } })
     ↑ 这里的 permissions 是从 PermissionSpec 翻译过来的沙箱 profile
  3. native-bridge 转发到 apollo-sandbox binary：
     - macOS: sandbox-exec + 动态生成 sbpl profile
     - Linux: landlock + seccomp
     - Windows: AppContainer（v2；MVP 提示 --dangerous-no-sandbox）
  4. sandbox 生成 profile 限制 syscall，即使 tool 有 bug 也无法逃逸
```

**双层安全**：
- **Permission** 防止 tool 拿到不该有的 spec（用户视角）
- **Sandbox** 防止 tool 实现绕过 spec（技术视角）

某些工具（`Todo` / 纯 JS `Glob`）没有 sandbox 需求，permission 通过后直接执行。

### 4.6 危险操作的额外保护

针对**破坏性**操作，permission 之外还有额外保护：

| 操作类型               | 额外保护                                                                     |
|------------------------|------------------------------------------------------------------------------|
| `Write` 覆盖已有文件   | 提示 "will overwrite N bytes"，diff 预览                                     |
| `Edit` 大规模变更      | > 100 行改动时提示 review                                                    |
| `Bash` `rm -rf` 类     | 硬编码 pattern 黑名单，直接拒绝（可用 `--dangerously-...` 覆盖）              |
| `Bash` `sudo`          | 直接拒绝 + 提示"不支持 sudo，请手动执行"                                     |
| `Bash` 修改 shell RC   | 匹配 `~/.zshrc` `~/.bashrc` 等 → 强制弹窗                                    |
| 网络类 (`WebFetch`)    | 首次访问某域名 → 弹窗（allow-session by domain）                              |
| 跨 cwd 的 fs 操作      | 超出 `cwd` 边界 → 弹窗，即使 permission cache 有                              |

### 4.7 Tool 注册与来源

```ts
export interface ToolRegistry {
  register(tool: Tool, source: ToolSource): Disposable
  unregister(name: string): void
  get(name: string): Tool | undefined
  forProvider(client: ProviderClient): ToolSchema[]  // 序列化成 provider 格式
}

export type ToolSource =
  | { kind: 'builtin' }
  | { kind: 'mcp',    server: string }
  | { kind: 'plugin', plugin: string }
```

**来源与名字冲突**：
- 内置工具占用固定名字（`Read` / `Write` / `Edit` / ...）
- MCP / 插件工具**必须**加前缀：MCP 用 `mcp:<server>:<tool>`；插件用 `plugin:<name>:<tool>`
- Registry 检测重名 → 拒绝注册 + 记 `error.raised`

**注册时机**：
- 内置：`apps/cli` 启动时注册
- MCP：`mcp-client` 连接后按 `list_tools` 结果注册
- 插件：`plugin-runtime` 加载插件调 `activate` 时通过 bridge 注册

**卸载**：所有注册返回 `Disposable`，MCP 断连 / 插件禁用时批量 dispose。

### 4.8 Tool 输入验证

- Registry 保存 `inputSchema` (JSON Schema)
- Runner 拿到 `tool_use` 后，先 **schema 验证 input**：
  - 通过 → 调 `permissionSpec(input)` → 走权限流程
  - 失败 → 立即返回 `{ isError: true, content: [{ type: 'text', text: 'Invalid input: <ajv error>' }] }`，不进 permission，不进 tool
- 这样模型看到错误后能自纠

### 4.9 Tool 结果规范化

- **文本超长截断**：超过 `TOOL_RESULT_MAX_TOKENS`（默认 25k tokens）→ 中段截断 + `[... truncated N tokens ...]` 标记
- **二进制内容**：转成 `{ type: 'file', source: AttachmentRef, mime, filename }`，进入 attachment 生命周期（§2.1.1）
- **错误消息**：不暴露内部路径 / 敏感 env；`ApolloError.toContentText()` 统一脱敏
- **诊断信息**：`meta` 里塞 `durationMs` / `bytesRead` 等，UI 侧展示，模型看不到

### 4.10 特殊工具：Task（subagent）

`Task` 工具是启动 subagent 的入口，见 §2.7 生命周期。

**特殊点**：
- 权限：`Task` 本身几乎不需 permission（不直接触碰系统），但**子 agent 的 tool 调用各自过 permission**
- 结果：从子 session 的最后一条 assistant message 提取 text 组成 tool_result
- 失败：子 agent 崩溃 = `tool_result.isError=true`，父 session 不受影响
- 嵌套上限：默认 3 层（§2.7）；`Task` 内部检查 `ctx.session.turn.parentDepth` 拒绝超深

### 4.11 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| Tool 抛异常 = bug（应 catch 内部转 `isError`）                                     | Runner 兜底 + 单元测试                          |
| Tool **禁止** import 具体 provider 包 / router / core Runner                       | ESLint 依赖规则                                 |
| Tool **禁止**绕过 `permissionSpec` 声明的资源边界（比如声明 read 却 write）         | code review                                     |
| Tool **禁止**直接调 native binary，必须走 `native-bridge`                           | ESLint no-restricted-imports                    |
| 破坏性 tool（Write / Edit / Bash）**必须**声明 sandbox 需求                        | tool 单元测试                                   |
| Permission 决策链**必须**按 §4.4 顺序，禁止跳过                                     | permission 单元测试                             |
| `permissionCache` 只在 session 内有效，进程重启失效                                 | SessionState 不持久化 permissionCache            |
| `permissions.toml` 修改**必须**通过 permission API，不允许工具直接写                | ESLint 白名单                                   |
| `--dangerously-skip-permissions` **必须**打警告日志 + UI 顶栏红条                  | apps/cli 强制                                   |
| MCP / 插件工具**必须**加前缀（`mcp:` / `plugin:`）                                 | Registry.register 校验                          |
| Tool `outputHint` **禁止**塞 secret / API key                                     | code review                                     |
| Tool 内的日志**必须**走 `ctx.logger`，不允许 `console.log`                          | ESLint no-console                               |

### 4.12 里程碑

- **L1（MVP）**：`Read` / `Write` / `Edit` / `Bash`（sandbox 必须） / `Grep` / `Glob` / `Todo`；permission 决策链完整；auto-allow 保守规则；弹窗串行
- **L2**：`MultiEdit`；`Skill.activate`（随 skills-runtime）；`Memory.write` / `Memory.read` / `Memory.list` / `Memory.update` / `Memory.delete`（随 memory-runtime，§6.12.2a）；danger patterns 黑名单；permission `allow-project` / `allow-forever` 存储
- **L3**：`Task` + subagent；`Memory.recall`（走 apollo-search 索引）；MCP 工具注入；插件工具注入
- **L4**：`WebFetch` / `WebSearch`；网络 permission 按 domain；跨 cwd 强制弹窗

