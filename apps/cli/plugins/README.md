# 内置插件（builtin plugins）

随 CLI 产物分发的插件，与 dev 插件（`~/.volund/plugins-dev/`）共用同一条装载链路：
manifest 校验 → bundle 完整性检查 → `volund-sandbox --run-plugin` 沙箱子进程 → fd3 JSONRPC 桥。
差异仅在目录来源——内置插件只信产物本身。

## 目录约定

- 源码：`apps/cli/plugins/<name>/`（`manifest.json` + 单文件零依赖 TS 入口
  `index.ts`，`main` 指向它）。只写 strip-types 可擦子集（interface / 类型标注可用；
  enum / namespace / 参数属性不支持），`import type` 取 SDK 类型——运行时零依赖，
  沙箱里解析不到 node_modules
- 装载（源码态）：dev/vitest 直接解析源码目录，沙箱对 `.ts` 入口自动追加 Node ≥ 22.6
  的 `--experimental-strip-types`（见 `crates/volund-sandbox/src/plugin.rs`）；Node <
  22.6 跑不了源码态内置插件，请用产物
- npm 产物：`pnpm build` 时把 `index.ts` 经嵌套 rolldown **编译并压缩混淆**（compress
  与顶层 mangle，仅保留沙箱装载依赖的 `activate` 导出名）成
  `dist/plugins/<name>/index.mjs`，产物 manifest 的 `main` 同步改写为 `index.mjs`——
  产物运行时不再依赖类型擦除（见 `rolldown.config.mjs`）。源码不随产物分发
- **.volund 分发（r1.6）**：编译后 `scripts/pack-builtin-plugins.mjs` 把每个中间目录
  打成 `dist/plugins/<name>.volund`（store zip、manifest.json 在根、字节级确定性）
  并删除中间目录。运行时 `loadBuiltinPlugins` 扫 `*.volund` 解包到
  `~/.volund/plugins-cache/<name>/` 再装载——**更新内置插件 = 覆盖对应 .volund 文件**；
  包文件名必须与 manifest `name` 一致，不一致拒载
- standalone 产物：`build:standalone` 直接复用 `dist/plugins/`（同一份 .volund 字节，
  见 `scripts/release/build-standalone.mjs`）
- 运行时解析（`builtinPluginRoot()`，runtime.ts）：`$VOLUND_STANDALONE_ASSET_DIR/plugins`
  → `dist/plugins`（bundled）→ `apps/cli/plugins`（源码/vitest），取第一个存在的
- 类型门：`pnpm --filter @volund/cli typecheck` 经 `tsconfig.plugins.json` 覆盖本目录
  全部 TS 源

## 版本对齐

内置插件与 CLI 同生命周期，`engines.volund` 用 `^<当前 minor>`；CLI 版本号 bump 时
同步 bump 各内置插件 manifest 的 `version` 与 `engines.volund`。

## 现有内置插件

| 插件                       | 贡献                                                                                                                              | 权限                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `volund-plugin-ask`        | system prompt fragment（引导模型需要用户拍板/被要求提问时走 `AskUserQuestion` 结构化提问，而非正文追问）                          | `prompt.contribute`                                                 |
| `volund-plugin-env`        | `/env` 斜杠命令（查看 `[env]` 配置段的生效状态与沙箱透传情况）                                                                    | `commands.register`, `env.read`, `log.write`                        |
| `volund-plugin-manager`    | `/plugins` 斜杠命令（三页签浏览 builtin/dev/market 装载清单 + `install`/`uninstall`/`help` 子命令，PLUGIN-MANAGER-r1）            | `commands.register`, `plugins.read`, `plugins.manage`, `log.write`  |
| `volund-plugin-web-search` | WebSearch provider（tavily / brave，经 `webSearch.provide` 热接进共享工具实例）+ `/web-search` 配置面板；配置在 `[web_search]` 段 | `webSearch.provide`, `http.fetch`, `commands.register`, `log.write` |
