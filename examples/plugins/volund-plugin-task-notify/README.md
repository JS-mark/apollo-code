# volund-plugin-task-notify（示例插件）

定时任务运行终态的 webhook 通知示例：演示 `hooks.on('task.completed' / 'task.failed')`
订阅 + `volund.http.fetch` 出网 + `/task-notify` 斜杠命令配置面板（storage 持久化）。
复制本目录到 `~/.volund/plugins/`（或按 dev 插件装载方式）即可改造使用。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/task-notify` | 查看当前配置与用法 |
| `/task-notify <url>` | 设置默认接收端（全部任务） |
| `/task-notify <taskId> <url>` | 为单个任务设置接收端（覆盖默认） |
| `/task-notify remove <taskId>` | 删除单任务路由 |
| `/task-notify off` | 清空全部配置 |

## 覆盖面与分工（重要）

- 本插件跑在**任务子会话**里：覆盖「子进程活着走完回合」的成功与失败。
- **超时击杀 / config drift / trust 丢失 / boot 收尸**没有会话载体，本插件看不到
  ——这些走宿主级 `[tasks].webhook_url`（daemon 侧权威通道，见
  `W17-scheduler-design.md` r1.5）。两者互补，不互替。

## 请求体格式

按接收端 host 自动选形（`index.ts` 的 `buildBody`，改这里即可适配任意接收端）：

- `oapi.dingtalk.com`（钉钉机器人）：`{ msgtype: 'text', text: { content } }`
- `hooks.slack.com`（Slack incoming webhook）：`{ text }`
- 其余：通用 JSON `{ text, event, taskId, runId, sessionId, durationMs?, reason? }`

## 网络安全模型

出网域由 manifest `permissions.net.allowlist` 把门（deny-by-default）。换接收端
host 时**必须同步编辑 `manifest.json`** 的 allowlist——这是插件网络的既定安全
模型，不是 bug。
