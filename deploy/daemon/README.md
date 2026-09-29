# volund daemon 保活资产（W-17）

OS scheduler 只负责让 `volund daemon` 活着，永远不自己实现调度（W-17 F1-01 单实现铁律）。
本目录是 launchd / systemd 保活配置的唯一随仓库分发处，语义样板的出处是
`docs/superpowers/specs/2026-07-31-volund-code-design/W17-scheduler-design.md` 的
「OS 保活」一节；`apps/cli/src/__tests__/daemon-keepalive.test.ts` 在 CI 里锁定两边
不漂移，以及保活配置所依赖的 daemon 退出契约。

## 退出契约（保活配置依赖它才不空转）

| 场景 | 退出 | 保活行为 |
| --- | --- | --- |
| 运行中把 `[tasks].enabled` 翻 false | exit 0（下一 tick 放锁自退） | `SuccessfulExit=false` / `Restart=on-failure` 不重启——不空转 |
| 冷启动时调度未启用 | exit 1（`tasks_disabled`） | 会被重拉——文档化前置条件：先 `enabled = true` 再装保活 |
| 第二个 daemon 抢锁 | exit 1（`task_daemon_running`） | 重拉后仍由 daemon.lock 单实例兜底，不双跑 |

## macOS（launchd）

```sh
cp deploy/daemon/cc.nexo.volund.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/cc.nexo.volund.daemon.plist
```

## Linux（systemd user unit）

```sh
mkdir -p ~/.config/systemd/user
cp deploy/daemon/volund-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now volund-daemon
```

前置：用户级 `config.toml` 设置 `[tasks] enabled = true`。Windows 用任务计划程序建
「登录时启动 + 失败重启」的基本任务运行 `volund daemon`（`schtasks /create /sc onlogon ...`）。
