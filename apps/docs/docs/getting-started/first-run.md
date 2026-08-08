# First run

## Trust the working directory

Before Apollo initializes a provider, tool, or session in a new directory, it shows the canonical (realpath) directory and asks for a trust scope:

- **Trust this folder only** stores an exact-path rule.
- **Trust parent folder tree** stores a tree rule for the displayed parent.
- **Trust folder and subdirectories** stores a tree rule for the current folder.
- **No, exit** (or `Esc`) exits before runtime initialization.

Directory trust permits Apollo to start in that location. It does not approve file writes, commands, network access, or bypass the permission manager and sandbox.

Headless and JSON runs fail with `directory_untrusted` instead of waiting for input. Automation may explicitly trust only the canonical current folder with `--trust-workspace`.

Use `apollo trust list` (or `--json`) to inspect user-level rules. Revoke one canonical rule with `apollo trust revoke <path>`, or clear all rules with `apollo trust revoke --all`. Rules live in `~/.apollo/trusted-directories.json`, never in the project repository.

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
