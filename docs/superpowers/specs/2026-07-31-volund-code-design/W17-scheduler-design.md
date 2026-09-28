# W-17 定时任务（F1）落地设计 + 威胁模型

状态：**r1 已落地**（2026-09-27，批次 1-4），对应 Web 计划 §11 F1-01~05。
本文是该能力的单一事实源：所有权拍板、执行模型、威胁模型、OS 保活与验收面。

## F1-01 · Scheduler ownership（拍板）

**用户级 daemon（`volund daemon`）是唯一的调度触发者。** 前台 server 寄生与
OS scheduler 两条实现路线不做——F1-01「不得在三个实现间隐式切换」由架构保证：

- 任务表的写操作只存在于 CLI（`volund tasks`）与 daemon；web `/api/v1/tasks`、
  移动站 `/v1/tasks` 两条面**只有 GET 路由**（mutation 端点故意不存在）。
- TUI / web / mobile 对任务表一律只读；doctor 的 `task scheduler` 检查项把
  「enabled 但 daemon 不在场」显式暴露为 ⚠️（任务不会触发）。

**开关即生命周期（r1.4，2026-09-28）**：`tasks.enabled` 翻转联动 daemon 启停——
`volund config set tasks.enabled true` 与 web 设置页开关都会：true 且 daemon 不在场 →
detached spawn（父进程退出不带走；已在场 no-op）；false → SIGTERM 在场 daemon。
TUI 启动自愈：enabled=true 而 daemon 不在场时补拉一次（进启动 notices）。
运行中 daemon 每 tick 重读 `[tasks]` 段：翻 false → 释放锁、exit 0 退出
（max_concurrent 热生效）。配套保活语义见下节 supervisor 样例（SuccessfulExit=false /
Restart=on-failure：开关关闭的 exit 0 不会被无限重启）。

## F1-02 · Task contract（已落 `tasks-schema.ts`）

创建时冻结：cwd、configHash（config.toml sha256，**`[tasks]` 段除外**——见下
r1.5 修订）、prompt、schedule
（interval/daily/weekly）、missedRun（skip/run_latest）、overlap（skip/queue）、
constraints（model/budget/allowedTools/timeoutMs/maxRetries）。
禁存 dangerous-skip 由 strictObject 形状保证：schema 没有任何提权/跳权字段。

**生命周期通知事件（r1.2，2026-09-27）**：任务运行在自己的会话流发射
`task.started` / `task.completed` / `task.failed`（附录 D.2 已登记，31 种事件）——
Runner 持 `RunnerOptions.taskRun` 元数据时发射（daemon 经 `VOLUND_TASK_RUN` env
注入，cli 读后即删防嵌套误认）。reason 枚举 `error | interrupted`；超时击杀
（SIGKILL）进程即死、task.failed 不发，由 journal 记账。调度决策类窗口
（missed/skipped）无会话载体，仍只在 TaskStore journal + web/mobile 只读面呈现。

**运行终态 webhook 通知（r1.5，2026-09-28）**：daemon 在 journal 落账后调用
`TaskRunNotifier` 端口（apps/cli/src/daemon.ts），生产实现 `createWebhookNotifier`
POST JSON。覆盖会话事件够不着的终态：超时 SIGKILL、config drift、trust 丢失、
boot 收尸都发 `task.failed` 形态通知；missed/skipped 记账不发。配置
`[tasks].webhook_url`（附录 C.2，项目级 forbidden；URL 每 tick 热重载，启动行只报
「webhook configured」不回显令牌）。payload：`event/taskId/taskName/runId/
scheduledFor/finishedAt/startedAt?/durationMs?/exitCode?/error?/sessionId?`；
2xx 即成功，4xx（除 408/429）配置性失败不重试，其余 0.5s 起步退避至 3 次，
耗尽只 warn——通知尽力而为，不反压记账与调度。
**configHash 修订（r1.5）**：hash 计算排除 `[tasks]` 整段（解析后删段 + 键序
归一化；解析失败退回全文 hash）——该段是运维面（开关/并发/journal 保留/通知
地址），不在任务执行语义里，改通知地址不要求重建全部任务；旧定义的冻结值
按新算法重算即失配，属一次性 `task_config_drift`，重建任务即可。
**插件 hook 接缝（r1.5）**：`HookEvent` 开放 `task.started/completed/failed`
（06a 表：18 种），会话事件广播（broadcastPluginLifecycleHook）把 §2.3 同名
事件 payload + sessionId 派发给插件 hooks.on / session.on 订阅——覆盖子进程
活着走完回合的成败，插件经 `volund.http.fetch`（manifest net allowlist）自做
通知路由。与 daemon 侧 webhook 的分工：超时击杀 / drift / trust / boot 收尸
只在宿主 webhook 通道，插件面是进程内增强路由（钉钉/Slack 格式化、按任务
分流），非替代。可运行参考实现：examples/plugins/volund-plugin-task-notify/
（hooks.on + http.fetch + /task-notify 斜杠命令配置面板，storage 持久化，
请求体按接收端 host 选形；出网域由 manifest net allowlist 把门）。

**会话内创建工具（r1.3，2026-09-28）**：`schedule_task` 工具（apps/cli/src/schedule-task-tool.ts，
注册进 volund.orchestration 域）让模型在对话里创建/管理任务——list/create/enable/disable/remove/runs
六个动作，写的就是 `volund tasks` 同一个 TaskStore（同锁同校验，configHash 同源冻结，cwd 缺省当前
工作区）。**触发权不变**：工具只写定义表，fire 仍由 daemon 独占（F1-01）。变更动作带
`{custom:{scheduleTask:{action,id?}}}` 权限门：交互模式弹卡确认，无人值守 none 模式默认 deny
（与 F1-03 同门）。创建返回附触发就绪检查（[tasks].enabled / daemon 在场），模型据此提醒用户补齐
触发条件。系统提示词零改动——工具描述即模型可见面。

执行面（r1.1，2026-09-27）：冻结约束经 headless 子进程旗标注入会话——
`--model`（session.model_changed 钉住）、`--budget <json>`（RunnerOptions.budget，
按回合计量）、`--allowed-tools <csv>`（与 agent 定义白名单取交，工具执行器收口）。
`timeoutMs` 由 daemon SIGKILL 承担。已知边界：budget 为回合粒度（单 prompt 单
turn 等价单次运行）；resume 场景不吃启动 overrides。

## F1-03 · Trust/permission

- 子进程执行（`spawn(execPath, [entry, prompt, --json])`，无 TTY）→ 会话
  permission interaction 为 `none`：无人值守默认 deny 一切未预授权能力。
- 每次触发先重算 configHash 与冻结值比对，漂移 → `task_config_drift` 拒跑；
  `readDaemonStatus` 同源的 trust 检查失败 → `task_trust_missing` 拒跑。
  两者均记账 failed 消费窗口（游标推进，不重复拒绝）。
- 插件/MCP 状态无陈旧问题：每次运行都是全新进程。

## F1-04 · Persistence/recovery（已落 `task-store.ts` + `scheduler-domain.ts`）

- 单实例：`<home>/daemon.lock`（活 pid → `task_daemon_running`；死 pid 回收）。
- 崩溃收尸：boot 把 journal 遗留 'running' 改判 failed（`task_run_failed`）。
- 错过窗口：早于本次 boot 的窗口按 missedRun 策略处理（skip 记账推进游标 /
  run_latest 只补跑最近一个）；boot 后的滞留窗口正常触发。
- 时钟/DST：Intl 墙钟解算（春拨缺失时刻顺延、秋拨取收敛侧——宁少触发不重复）。
- 调度游标（cursors）与 journal 分离：retention 截断不吃游标，长停机可追账。
- 容量：max_concurrent 满则整批 defer（游标不推进下 tick 重估）；同任务单
  tick 只 spawn 最新窗口，防突发风暴。
- stop() 只放锁不杀在途子进程；孤儿运行由下一次 boot 收尸。

## 威胁模型（F1-05）

资产：本机文件系统/网络凭据；对手：clone 来的仓库（项目级 config）、
同机其他进程、被透传的不可信内容。

1. **项目级 config 不得启停调度器或改写资源参数**——`[tasks]` 段全部
   projectOverride forbidden（§8.3.1 数据流向门）。clone 仓库不能给自己排任务。
2. **任务定义无提权面**——schema strictObject；运行时 permission 'none'
   默认 deny；daemon 永不传 `--dangerously-skip-permissions`。
3. **信任边界重验**——trust/configHash 每次运行前重验（F1-03）。
4. **web/mobile 只读**——两条 HTTP 面均无任务写端点；web 走 browser session +
   CSRF + loopback；移动站走 relay 设备 token + 隧道，落本机仍是只读方法。
5. **daemon 单实例**——锁文件语义保证只有一个调度者，杜绝双 daemon 竞态双跑。
6. **子进程环境继承 daemon**——daemon 进程的 env（含可能的密钥）对任务会话
   可见，与交互式 TUI 同面（同用户同权限）。daemon 不做提权、不监听网络。
7. **锁/快照文件**——`0o600` 文件、`0o700` 目录（~/.volund），不跨用户边界。
8. **prompt 是机器所有者输入**——`volund tasks add` 只能由本机用户执行；
   内容不过网关、不进项目级任何文件。

## OS 保活（launchd / systemd / 任务计划程序）

7x24 的最终一环是 OS 层保活：**OS scheduler 只负责让 `volund daemon` 活着，
永远不自己实现调度**（F1-01 单实现铁律）。

macOS（launchd，`~/Library/LaunchAgents/cc.nexo.volund.daemon.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cc.nexo.volund.daemon</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/volund</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- SuccessfulExit=false：只在异常退出时拉起；开关关闭的 exit 0 不空转 -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/volund-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/volund-daemon.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/cc.nexo.volund.daemon.plist`。

Linux（systemd user unit，`~/.config/systemd/user/volund-daemon.service`）：

```ini
[Unit]
Description=volund task daemon

[Service]
ExecStart=/usr/local/bin/volund daemon
# on-failure：开关关闭的 exit 0 不重启；崩溃才拉起
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`systemctl --user enable --now volund-daemon`。

Windows：任务计划程序建「登录时启动 + 失败重启」的基本任务运行
`volund daemon`（schtasks /create /sc onlogon ...）。

前置：config.toml `[tasks] enabled = true`（daemon 拒绝在关闭状态下调度）。
保证 daemon 单实例由 daemon.lock 承担，KeepAlive 多余拉起会立即
`task_daemon_running` 退出——不产生双跑。

## 验收面（F1-05 现状）

- 单元/集成：tasks-schema（8）、task-store（13）、scheduler-domain（16）、
  daemon 宿主（16）、tasks 命令族（6）、doctor 检查（3）、web 路由（3）、
  会话约束注入（session-controller overrides +1）——含锁竞争/损坏恢复/DST/
  容量/单实例语义。
- L1 e2e：scripts/l1-local-e2e 新增 daemon 生命周期场景（tasks add → 补跑触发 →
  journal 记账 → 单实例拒启），走构建产物全链路。
- 实机冒烟：构建产物跑 daemon → run_latest 补跑 → spawn 真子进程 → journal
  failed（无凭据子进程退出码 1）→ SIGTERM 退出，全链路闭环。
- OS matrix：锁/快照模式与 memory-runtime 同款（Windows LL-7 瞬态码已覆盖）；
  launchd/systemd 保活本身未进三 OS CI 矩阵（后续项）。
