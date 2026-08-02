# CLI reference

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
| `apollo hook list`             | List built-in hooks.                                                      |
| `apollo version`               | Print the version.                                                        |
| `apollo help`                  | Show command help.                                                        |

Common modes include `--no-tui`, `--json`, and `--no-color`. Non-interactive runs do not load project configuration unless `--trust-project-config` is supplied. Dangerous sandbox bypass flags are audited and require explicit confirmation.

Use `apollo restore <session-id> --dry-run` to preview a rollback. Every `Write`, `Edit`, and `MultiEdit` operation records a session-scoped backup first. Restore refuses to overwrite files changed after Apollo's edit. Backups are retained for seven days by default and bounded to 500 MB.

Resume marks an unfinished turn as aborted and starts from a new turn; it never re-runs an incomplete provider or tool call.
