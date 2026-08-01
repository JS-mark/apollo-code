# First run

Run `apollo` in a repository. Before Apollo writes configuration, onboarding explains the local-only telemetry default and the detected Sandbox Tier.

1. Choose Anthropic as the provider.
2. Enter the API key only in Apollo's masked credential prompt. Never paste it into chat, shell history, logs, an issue, or a commit.
3. Apollo verifies the credential before storing it in the OS keychain or encrypted fallback store.
4. Review every requested write, command, and network permission. Deny requests you do not understand.

Use `apollo doctor --strict` before a real task. A degraded sandbox exits with code 3. `--dangerously-no-sandbox` requires an explicit risk confirmation and should not be used for release acceptance.
