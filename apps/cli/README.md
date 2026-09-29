# @volund/cli

The CLI entry package of Volund. It owns the `volund` binary, the full command surface, and the production wiring that connects kernel services (sessions, tools, permissions, providers, plugins, MCP, scheduled tasks) to user-facing commands, plus the Ink TUI bootstrap and the embedded web console auto-start.

## Build and run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/volund.js --help
```

`package.json` declares the `volund` bin (pointing at `dist/volund.js`); inside the workspace that file runs directly via Node, and after a published install the same file is exposed as the `volund` command.

Command groups implemented in `src/`: chat (interactive TUI / one-shot NDJSON), resume/restore, login/logout, status, config, history/sessions, doctor, memory, telemetry, tasks/daemon, trust, plugin/plugins, remote, mcp, skill, context, evolution, hook, version, and help.

## Documentation

- CLI reference: [apps/docs/docs/reference/cli.md](../docs/docs/reference/cli.md)
- First-run guide: [apps/docs/docs/getting-started/first-run.md](../docs/docs/getting-started/first-run.md)
- JSON output contract: [apps/docs/docs/reference/json-output.md](../docs/docs/reference/json-output.md)
