# First run

Run `apollo` or `apollo chat` in a repository. With an interactive terminal and
no prompt argument, Apollo starts the Ink TUI and shows a `> ` input line. Before
Apollo writes configuration, onboarding explains the local-only telemetry default
and the detected Sandbox Tier.

1. Choose Anthropic as the provider.
2. Enter the API key only in Apollo's masked credential prompt. Never paste it into chat, shell history, logs, an issue, or a commit.
3. Apollo verifies the credential before storing it in the OS keychain or encrypted fallback store.
4. Review every requested write, command, and network permission. Deny requests you do not understand.

Use `apollo doctor --strict` before a real task. A degraded sandbox exits with code 3. `--dangerously-no-sandbox` requires an explicit risk confirmation and should not be used for release acceptance.

For local checks, `apollo chat --no-tui` forces the line-mode fallback, while
`apollo chat "prompt" --json` emits NDJSON for automation and does not start the
TUI.
