# @volund/web

The Volund web console: a Next.js app in static-export mode (`output: 'export'`, pure client-side — antd, Monaco, xterm) served by the loopback `@volund/web-server`. In production it auto-starts alongside the TUI and serves the workspace over loopback-only HTTP/SSE (`/api/v1` with browser-session + CSRF); there is no separate `volund web` command.

## What it covers

Routes implemented in `src/`: chat (session sidebar, streaming, approvals), code workbench (explorer, editor, git, changes, terminal), status, tasks, remote control, stats, manage (plugins / skills / MCP / market), settings, and shortcuts.

## Build and run

```bash
pnpm --filter @volund/web dev     # UI development on http://localhost:3030
pnpm --filter @volund/web build   # static export into out/
```

The static export in `out/` is what the CLI embeds and serves; `dev` renders the UI shell only — the data plane (`/api/v1`) exists inside the CLI-hosted loopback server.

## Documentation

- CLI reference (commands that own the server side): [apps/docs/docs/reference/cli.md](../docs/docs/reference/cli.md)
- Marketplace guide (market page contract): [apps/docs/docs/guides/marketplace.md](../docs/docs/guides/marketplace.md)
