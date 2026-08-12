# CLI reference

## Directory trust

```sh
apollo trust list [--json]
apollo trust revoke <path>
apollo trust revoke --all
apollo chat --cwd <path> --trust-workspace "prompt"
```

`--trust-workspace` is the scriptable opt-in for non-interactive runs. It persists an exact canonical-path rule; it never grants a parent or subtree scope.

## Context evolution (L2)

`apollo evolution show [--namespace context] [--since <date>]` displays the sanitized, append-only local tuning audit. `apollo evolution rollback [--namespace context] [--to <timestamp>]` restores context parameters to the preceding or selected point. Setting `[evolution] enabled = false` in `~/.apollo/config.toml` makes new sessions use built-in context defaults.

| Command                        | Purpose                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `apollo` / `apollo chat`       | Start an interactive or one-shot coding session.                          |
| `apollo login <provider>`      | Verify, then securely store a provider credential.                        |
| `apollo logout <provider>`     | Remove a stored provider credential.                                      |
| `apollo config`                | Inspect configuration.                                                    |
| `apollo history list` / `show` | Inspect local session history.                                            |
| `apollo resume <session-id>`   | Resume at the last durable turn boundary.                                 |
| `apollo restore <session-id>`  | Restore files changed during a session.                                   |
| `apollo doctor [--strict]`     | Check configuration, credentials, native packages, and sandbox readiness. |
| `apollo memory <action>`       | Search, diagnose, or rebuild the local derived memory index.              |
| `apollo plugin <action>`       | Install, list, diagnose, enable, disable, or uninstall local plugins.     |
| `apollo hook list`             | List built-in hooks.                                                      |
| `apollo version`               | Print the version.                                                        |
| `apollo help`                  | Show command help.                                                        |

Common modes include `--no-tui`, `--json`, and `--no-color`. Non-interactive runs do not load project configuration unless `--trust-project-config` is supplied. Dangerous sandbox bypass flags are audited and require explicit confirmation.

For automation, see the [versioned NDJSON and management JSON contract](./json-output.md). Chat `--json` is an event stream and disables the TUI; management commands return one JSON document.

Use `apollo restore <session-id> --dry-run` to preview a rollback. Every `Write`, `Edit`, and `MultiEdit` operation records a session-scoped backup first. Restore refuses to overwrite files changed after Apollo's edit. Backups are retained for seven days by default and bounded to 500 MB.

Resume marks an unfinished turn as aborted and starts from a new turn; it never re-runs an incomplete provider or tool call.

Inside interactive chat, `/resume` opens the same saved-session picker. Cancelling or a failed resume leaves the current session and input history unchanged.

## Local memory search and recovery

```sh
apollo memory search <query> [--scope workspace|project|session] [--limit 10] [--tag tag] [--json]
apollo memory doctor [--strict] [--json]
apollo memory reindex [--check] [--force] [--batch-size 250] [--json]
```

Search is local keyword matching only and performs no embedding or network request. Index hits are always read back through the scoped fact service, so stale, deleted, ghost, and unauthorized entries are not returned. `memory doctor` is read-only. `memory reindex --check` reports whether rebuilding is required, while a normal rebuild uses a cross-process lock and atomically publishes a new generation only after every batch succeeds. `--force` rebuilds a healthy generation and may clear a stale lock, but never steals a lock owned by a live process.

## Local telemetry

`apollo telemetry show` summarizes locally stored Tier and sandbox escape decisions. A missing sample is reported as unknown, never as passing. `apollo telemetry export <path>` exports a freshly redacted JSONL copy, and `apollo telemetry clear` clears the active local file. `apollo doctor` reports sink writability and damaged JSONL lines.

Telemetry stays local by default. Apollo does not enable an OpenTelemetry exporter unless one is explicitly configured; telemetry never changes sandbox permissions or Tier selection.

## Role routing

Role routing is configured in the trusted global `~/.apollo/config.toml`. A role selects an explicit provider/model candidate chain; failures, cooldowns, retry limits, time/cost budgets, and sticky tool-use turns remain governed by `FallbackRouter`.

```toml
[router]
type = "role"

[router.default]
provider = "anthropic"
model = "claude-sonnet-4-5"

[router.roles.planner]
provider = "openai"
model = "gpt-4o-mini"
priority = 100

[router.roles.coder]
provider = "anthropic"
model = "claude-sonnet-4-5"
priority = 100

[router.roles.reviewer]
provider = "anthropic"
model = "claude-opus-4"
priority = 100
```

`planner`, `coder`, and `reviewer` hints may come from explicit input/hook metadata or built-in subagent types. An explicit `provider/model` hint wins for that turn. Once a provider emits the first tool-use chunk, it remains sticky until the turn ends; a retry may not cross providers.

Provider plugins never enter a role or fallback candidate pool merely by registering. Name one in a role/fallback entry to opt in, or select it explicitly for one turn. Plugin providers cannot be the default provider in v1.

## Plugins

`apollo plugin install <local-directory>` validates the manifest and bundle, displays requested Apollo permissions, and installs only after explicit approval. New and resumed sessions activate only installed, approved, enabled plugins through the native sandbox host. Registered tools must use the `plugin:<manifest-name>:<tool-name>` namespace; their results are wrapped as untrusted content. Disabling or uninstalling a plugin terminates its host and removes its registrations, while enabling it restores activation for the active session. Use `plugin list [--json]`, `plugin doctor <name>`, `plugin enable|disable <name>`, and `plugin uninstall <name>` to manage the local copy. Registry and GitHub install specs, upgrades, and the L4 development hot-reload command are not implemented yet.
