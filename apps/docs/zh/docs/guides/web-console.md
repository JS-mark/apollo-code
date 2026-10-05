# Web 控制台

Volund 自带一个本地 Web 控制台，**随 TUI 静默自启**——没有独立的 `volund web` 子命令。它与会话终端共享同一进程、同一会话、同一审批队列：任一端决策，全端清卡。

## 启动与关闭

- **默认**：开启。每次 `volund` TUI 启动都会打印控制台地址（仅绑定回环，如 `http://127.0.0.1:<port>`）。
- **固定端口**：在 `~/.volund/config.toml` 设置 `web.port`。控制台会记住上次端口，被占用时回退随机端口。
- **关闭**：用户级配置设置 `[web] enabled = false`，或临时 `VOLUND_WEB=0` 启动。控制台失败绝不阻塞 TUI——只作为启动提示出现。

## 安全模型

- **仅回环**：服务只绑 `127.0.0.1`，网络侧不可达。
- **无 token 门**：URL 不带 token。首次访问时服务端自动签发 HttpOnly `SameSite=Strict` 会话 cookie 与 CSRF token；变更类请求要求同站 `Origin` 精确匹配 + `X-Volund-Csrf` 头。
- **加固头**：每请求 CSP nonce（`script-src 'self'`，绝无 `unsafe-inline`）、`frame-ancestors 'none'`、Host/Origin 精确匹配（抗 DNS rebinding）。
- **服务重启**：响应携带 `bootId`，客户端识别重启后自动清理过期状态。

## 功能一览

| 区域 | 要点                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 聊天 | 流式回复、审批卡、提问卡、图片附件、**发送排队**（回合中输入的消息进队列、回合结束依序自动发出，可拖拽排序） |
| 代码 | 工作台文件树、Monaco 编辑器保存（写前备份进会话 undo 管线）、WebSocket 交互式终端                            |
| 状态 | 会话状态面板、插件贡献的 `/status` 页签                                                                      |
| 管理 | MCP server（添加/查看/启停/**OAuth 认证**）、Skill（安装/市场）、Memory 编辑器、插件管理器                   |
| 任务 | 定时任务定义与运行 journal（经远程网关时只读）                                                               |
| Subagents | 子代理运行注册表（状态/用量/时长），运行中的可取消（经远程网关时走隧道）                                     |
| 远程 | 网关配对、设备管理、远程控制状态                                                                             |
| 设置 | 配置查看/编辑、快捷键、会话统计                                                                              |

## 配置键

```toml
[web]
enabled = true          # false 关闭自启
port = 3777             # 0 = 记住上次 / 随机回退

[web.terminal]
shell = "/bin/zsh"      # 工作台终端 shell
font_size = 13
scrollback = 5000
```

全部为用户级键（凭据相邻面项目级 forbidden；`web.*` 属本机自身面）。开发时可用 `VOLUND_WEB_ASSET_DIR` 覆盖资产目录。

## 故障排查

- **升级后白屏**：旧哈希资产被缓存——强制刷新即可（服务端已把 `index.html` 标为 no-store，前置代理缓存仍可能钉死旧版）。
- **"Assets are not built" 占位页**：当前分发行缺少控制台产物——0.2.x 起 npm/standalone 包已随包分发；开发构建需先 `pnpm --filter @volund/web build`。
- **Web 端审批卡不弹**：权限交互模式归 TUI 所有，控制台只是共享队列的镜像；若 TUI 以 `--yolo` 启动，任何端都不会排队。
