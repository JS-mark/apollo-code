# CLI 参考

## Context 自进化（L2）

`apollo evolution show [--namespace context] [--since <date>]` 查看经过脱敏、仅追加的本地调优审计；`apollo evolution rollback [--namespace context] [--to <timestamp>]` 将 context 参数恢复到上一次或指定时间点。`~/.apollo/config.toml` 中设置 `[evolution] enabled = false` 后，新会话使用内置 context 默认值。

| 命令                           | 用途                                   |
| ------------------------------ | -------------------------------------- |
| `apollo` / `apollo chat`       | 启动交互式或单次编程会话。             |
| `apollo login <provider>`      | 验证并安全保存 provider 凭据。         |
| `apollo logout <provider>`     | 删除已保存的 provider 凭据。           |
| `apollo config`                | 查看配置。                             |
| `apollo history list` / `show` | 查看本地会话历史。                     |
| `apollo resume <session-id>`   | 从最后一个持久化 turn 边界恢复。       |
| `apollo restore <session-id>`  | 回滚该会话修改过的文件。               |
| `apollo doctor [--strict]`     | 检查配置、凭据、原生包和沙箱状态。     |
| `apollo plugin <action>`       | 安装、列出、诊断、启停或卸载本地插件。 |
| `apollo hook list`             | 列出内置 hooks。                       |

`apollo plugin install <本地目录>` 会校验 manifest 与 bundle、展示权限，并仅在明确批准后安装。新建和恢复会话只会通过原生沙箱宿主激活已安装、已批准且 enabled 的插件。工具必须使用 `plugin:<manifest-name>:<tool-name>` 命名空间，返回内容会标记为 untrusted；disable 或 uninstall 会终止宿主并清除注册，enable 会在活动会话中恢复加载。可用 `plugin list [--json]`、`plugin doctor <name>`、`plugin enable|disable <name>` 和 `plugin uninstall <name>` 管理。registry/GitHub spec、升级与 L4 热重载尚未实现。
| `apollo version` | 输出版本。 |
| `apollo help` | 显示帮助。 |

常用模式包括 `--no-tui`、`--json` 和 `--no-color`。非交互运行不会加载项目配置，除非显式传入 `--trust-project-config`。危险沙箱绕过参数会被审计，并要求显式确认。

使用 `apollo restore <session-id> --dry-run` 可预览回滚。每次 `Write`、`Edit` 和 `MultiEdit` 修改文件前都会生成会话级备份；如果文件在 Apollo 编辑后又被修改，restore 会拒绝覆盖。备份默认保留七天，总量限制为 500 MB。

Resume 会把未完成的 turn 标记为 aborted，并从新 turn 继续；不会重新执行中断的 provider 或工具调用。
