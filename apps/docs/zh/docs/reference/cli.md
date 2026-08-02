# CLI 参考

| 命令                           | 用途                               |
| ------------------------------ | ---------------------------------- |
| `apollo` / `apollo chat`       | 启动交互式或单次编程会话。         |
| `apollo login <provider>`      | 验证并安全保存 provider 凭据。     |
| `apollo logout <provider>`     | 删除已保存的 provider 凭据。       |
| `apollo config`                | 查看配置。                         |
| `apollo history list` / `show` | 查看本地会话历史。                 |
| `apollo resume <session-id>`   | 从最后一个持久化 turn 边界恢复。   |
| `apollo restore <session-id>`  | 回滚该会话修改过的文件。           |
| `apollo doctor [--strict]`     | 检查配置、凭据、原生包和沙箱状态。 |
| `apollo hook list`             | 列出内置 hooks。                   |
| `apollo version`               | 输出版本。                         |
| `apollo help`                  | 显示帮助。                         |

常用模式包括 `--no-tui`、`--json` 和 `--no-color`。非交互运行不会加载项目配置，除非显式传入 `--trust-project-config`。危险沙箱绕过参数会被审计，并要求显式确认。

使用 `apollo restore <session-id> --dry-run` 可预览回滚。每次 `Write`、`Edit` 和 `MultiEdit` 修改文件前都会生成会话级备份；如果文件在 Apollo 编辑后又被修改，restore 会拒绝覆盖。备份默认保留七天，总量限制为 500 MB。

Resume 会把未完成的 turn 标记为 aborted，并从新 turn 继续；不会重新执行中断的 provider 或工具调用。
