# CLI reference

| Command                        | Purpose                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `apollo` / `apollo chat`       | Start an interactive or one-shot coding session.                          |
| `apollo login <provider>`      | Verify, then securely store a provider credential.                        |
| `apollo logout <provider>`     | Remove a stored provider credential.                                      |
| `apollo config`                | Inspect configuration.                                                    |
| `apollo history list` / `show` | Inspect local session history.                                            |
| `apollo doctor [--strict]`     | Check configuration, credentials, native packages, and sandbox readiness. |
| `apollo hook list`             | List built-in hooks.                                                      |
| `apollo version`               | Print the version.                                                        |
| `apollo help`                  | Show command help.                                                        |

Common modes include `--no-tui`, `--json`, and `--no-color`. Non-interactive runs do not load project configuration unless `--trust-project-config` is supplied. Dangerous sandbox bypass flags are audited and require explicit confirmation.
