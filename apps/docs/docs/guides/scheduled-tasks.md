# Scheduled tasks

Volund can run prompts on a schedule through a dedicated 7x24 scheduler daemon. A task is a persistent definition, not a dotfile cron line: it freezes its working directory and a configuration hash at creation time, records every run in a local journal, and is fired only by the daemon.

## Enable the scheduler

The scheduler is off by default. Set `[tasks].enabled = true` in your **user-level** config (`~/.volund/config.toml`):

```toml
[tasks]
enabled = true
# max_concurrent = 2                        # concurrent task sessions (1-8)
# journal_retention = 200                   # run-journal entries to keep (10-10000)
# webhook_url = "https://example.com/hook"  # notify on completed/failed runs
```

The whole `[tasks]` section is machine-owner territory: project-level config (for example, a cloned repository) can never enable the scheduler or change these values — they are rejected as project overrides.

Start the daemon and keep it alive with your init system:

```sh
volund daemon    # foreground; Ctrl+C stops it
```

Keep-alive assets ship with the repo under `deploy/daemon/`: a launchd agent (`cc.nexo.volund.daemon.plist` — copy to `~/Library/LaunchAgents/` and `launchctl load` it) and a systemd user unit (`volund-daemon.service` — copy to `~/.config/systemd/user/` and `systemctl --user enable --now volund-daemon`). Both restart the daemon only on abnormal exit, and the exit-code contract they rely on is locked in CI (`daemon-keepalive.test.ts`).

- Only the daemon fires scheduled tasks. A second daemon exits with `task_daemon_running` while one holds the scheduling lock.
- Flipping `[tasks].enabled` back to `false` makes a running daemon exit cleanly on its next tick. Under launchd (`SuccessfulExit=false`) or systemd (`Restart=on-failure`) this means the disabled state does not respawn-loop.
- `volund doctor` reports scheduler health and warns when tasks are enabled but no daemon is running.

## Managing tasks

```sh
volund tasks list [--json]
volund tasks add --name "Nightly review" --prompt "Summarize yesterday's commits" --schedule daily:09:00
volund tasks enable <id>
volund tasks disable <id>
volund tasks remove <id>
volund tasks runs <id> [--limit N] [--json]
```

`add` freezes the working directory and a hash of the **user-level** `config.toml` into the task definition (see [run semantics](#what-a-run-looks-like)).

### Schedule specs

| Spec                        | Meaning                                        |
| --------------------------- | ---------------------------------------------- |
| `interval:<n><ms\|s\|m\|h>` | Every n units (minimum 60 seconds)             |
| `daily:HH:MM`               | Every day at HH:MM (24h clock, task time zone) |
| `weekly:<days>@HH:MM`       | Days as `mon,wed,fri` or `0-6` (0 = Sunday)    |

### Add flags

| Flag                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `--cwd <path>`                | Working directory the task runs in (default: current) |
| `--id <id>`                   | Task id (default: slugified name)                     |
| `--tz <iana>`                 | IANA time zone (default: host local)                  |
| `--missed <skip\|run_latest>` | Policy for windows missed while the daemon was down   |
| `--overlap <skip\|queue>`     | Policy when the previous run is still in flight       |
| `--model <id>`                | Pin a provider/model for the task's runs              |
| `--timeout-ms <n>`            | Per-run wall-clock limit (the daemon kills overruns)  |
| `--max-retries <n>`           | Retry budget for failed runs (0-10)                   |
| `--disabled`                  | Create the task without enabling it                   |

## What a run looks like

Each run spawns a fresh headless Volund child (`<prompt> --json`) in the task's frozen working directory. The prompt runs unattended — permission interaction is disabled — so author task prompts accordingly. Frozen constraints are injected as flags: the pinned model, a budget object (`costUSDMax` / `tokenMax` / `timeMsMax`), and a comma-separated tool allowlist — the latter two are contract-reserved for now (the schema and runner support them, but no CLI or tool flag sets them yet). A run that exceeds `--timeout-ms` is killed and recorded as failed.

Before executing, the daemon re-checks two safety gates and refuses the run when they fail:

- **Config drift** (`task_config_drift`) — the hash of the user-level `config.toml` (with the `[tasks]` section excluded) differs from the value frozen at creation time.
- **Trust** (`task_trust_missing`) — the frozen working directory is no longer a trusted directory.

Terminal states (`completed` / `failed`) are posted to `[tasks].webhook_url` when configured. The URL is re-read on every delivery, so editing the config takes effect without restarting the daemon.

## Scheduling from a session

The model manages the same task store in-session through the `schedule_task` tool — `volund tasks` and the tool share one store, one lock, and one validation path. Mutations (create / enable / disable / remove) go through the normal permission decision chain: an approval card in interactive mode, automatic denial in unattended (`none`) mode. `list` and `runs` are read-only. Creation reports trigger readiness — whether `[tasks].enabled` is set and a daemon is running — so a task that would never fire is surfaced instead of silently queued.

The web console's Scheduled tasks panel manages the same store through the embedded web API (enable / disable / remove); task creation stays with `volund tasks add` and the `schedule_task` tool. When the console is reached through the remote gateway, the panel is read-only (`tasks.status/list/runs`).

## Reference

- CLI: `volund tasks` / `volund daemon` in the [CLI reference](../reference/cli.md).
- Error codes: `tasks_disabled`, `task_daemon_running`, `task_definition_invalid`, `task_io`, `task_run_failed`, `task_store_corrupt`, `task_config_drift`, `task_trust_missing` in the [error code reference](../reference/error-codes.md).
