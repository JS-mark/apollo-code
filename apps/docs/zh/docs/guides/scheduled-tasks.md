# 定时任务

Volund 通过一个专门的 7x24 调度 daemon 按计划运行 prompt。任务是持久化的定义，不是散落在 dotfile 里的 cron 行：创建时冻结工作目录与配置 hash，每次运行都记录在本地 run journal，并且只有 daemon 会真正触发执行。

## 启用调度器

调度器默认关闭。在**用户级**配置（`~/.volund/config.toml`）中设置 `[tasks].enabled = true`：

```toml
[tasks]
enabled = true
# max_concurrent = 2                        # 并发任务会话数（1-8）
# journal_retention = 200                   # run journal 保留条数（10-10000）
# webhook_url = "https://example.com/hook"  # 运行终态（completed/failed）通知地址
```

`[tasks]` 整段属于机器所有者：项目级配置（比如 clone 来的仓库）永远无法启用调度器或修改这些值——它们会被当作 project override 拒绝。

然后启动 daemon 并交给 init 系统保活：

```sh
volund daemon    # 前台运行；Ctrl+C 停止
```

- 只有 daemon 会触发定时任务。已有一个 daemon 持有调度锁时，第二个 daemon 会以 `task_daemon_running` 退出。
- 把 `[tasks].enabled` 翻回 `false` 后，运行中的 daemon 会在下一个 tick 干净退出。配合 launchd（`SuccessfulExit=false`）或 systemd（`Restart=on-failure`），禁用状态不会陷入重启循环。
- `volund doctor` 会报告调度器健康状态；任务已启用但没有 daemon 在场时会给出警告。

## 管理任务

```sh
volund tasks list [--json]
volund tasks add --name "每晚提交回顾" --prompt "总结昨天的 commits" --schedule daily:09:00
volund tasks enable <id>
volund tasks disable <id>
volund tasks remove <id>
volund tasks runs <id> [--limit N] [--json]
```

`add` 会把工作目录与**用户级** `config.toml` 的内容 hash 冻结进任务定义（见[运行语义](#运行是什么样子)）。

### Schedule 写法

| 写法 | 含义 |
| --- | --- |
| `interval:<n><ms\|s\|m\|h>` | 每 n 个单位一次（最小 60 秒） |
| `daily:HH:MM` | 每天 HH:MM（24 小时制，任务时区） |
| `weekly:<days>@HH:MM` | 星期写 `mon,wed,fri` 或 `0-6`（0 = 周日） |

### add 的 flag

| Flag | 用途 |
| --- | --- |
| `--cwd <path>` | 任务运行的工作目录（默认：当前目录） |
| `--id <id>` | 任务 id（默认：名称 slug 化） |
| `--tz <iana>` | IANA 时区（默认：宿主本地时区） |
| `--missed <skip\|run_latest>` | daemon 离线期间错过的窗口如何处理 |
| `--overlap <skip\|queue>` | 上一次运行还在跑时的重叠策略 |
| `--model <id>` | 为该任务的运行钉住 provider/model |
| `--timeout-ms <n>` | 单次运行的墙钟上限（超时由 daemon 击杀） |
| `--max-retries <n>` | 失败运行的重试预算（0-10） |
| `--disabled` | 以禁用状态创建 |

## 运行是什么样子

每次运行都会在任务冻结的工作目录里 spawn 一个全新的 headless Volund 子进程（`<prompt> --json`）。prompt 无人值守运行——权限交互被关闭——所以写任务 prompt 时要按这个前提来。冻结的约束以旗标注入：钉住的 model、预算对象（`costUSDMax` / `tokenMax` / `timeMsMax`）、逗号分隔的工具白名单——后两者目前是契约预留（schema 与 runner 已支持，但还没有任何 CLI/工具入口能设置）。超过 `--timeout-ms` 的运行会被击杀并记为失败。

执行前 daemon 会重查两道安全门，任一失败即拒绝本次运行：

- **配置漂移**（`task_config_drift`）——用户级 `config.toml` 的内容 hash（不含 `[tasks]` 段）与创建时冻结值不一致。
- **信任**（`task_trust_missing`）——冻结的工作目录已不再是受信任目录。

运行终态（`completed` / `failed`）在配置了 `[tasks].webhook_url` 时投递 webhook。地址在每次投递时重读，改配置不需要重启 daemon。

## 会话内排任务

模型可以在会话内通过 `schedule_task` 工具管理同一个任务存储——`volund tasks` 与该工具共用一个 store、一把锁、一条校验路径。变更动作（create / enable / disable / remove）走统一的权限决策链：交互模式弹审批卡，无人值守（`none`）模式自动拒绝。`list` 与 `runs` 只读放行。创建应答会附带触发就绪检查——`[tasks].enabled` 是否已开、daemon 是否在场——「创建了但永不执行」会在创建时就被点出来，而不是静默排队。

Web 控制台的定时任务面板经内嵌 web API 管理同一个存储（启停 / 删除）；任务创建仍走 `volund tasks add` 与 `schedule_task` 工具。经远程网关接入时面板只读（`tasks.status/list/runs`）。

## 参考

- CLI：[CLI 参考](../reference/cli.md) 中的 `volund tasks` / `volund daemon`。
- 错误码：[错误码参考](../reference/error-codes.md) 中的 `tasks_disabled`、`task_daemon_running`、`task_definition_invalid`、`task_io`、`task_run_failed`、`task_store_corrupt`、`task_config_drift`、`task_trust_missing`。
