# CLI 参考

| 命令                           | 用途                               |
| ------------------------------ | ---------------------------------- |
| `apollo` / `apollo chat`       | 启动交互式或单次编程会话。         |
| `apollo login <provider>`      | 验证并安全保存 provider 凭据。     |
| `apollo logout <provider>`     | 删除已保存的 provider 凭据。       |
| `apollo config`                | 查看配置。                         |
| `apollo history list` / `show` | 查看本地会话历史。                 |
| `apollo doctor [--strict]`     | 检查配置、凭据、原生包和沙箱状态。 |
| `apollo hook list`             | 列出内置 hooks。                   |
| `apollo version`               | 输出版本。                         |
| `apollo help`                  | 显示帮助。                         |

常用模式包括 `--no-tui`、`--json` 和 `--no-color`。非交互运行不会加载项目配置，除非显式传入 `--trust-project-config`。危险沙箱绕过参数会被审计，并要求显式确认。
