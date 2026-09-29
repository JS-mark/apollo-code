# MCP servers

> `.volund` configuration paths are frozen storage compatibility identifiers. Use `volund` for all
> CLI commands.

Volund is an MCP client (stdio + Streamable HTTP, with automatic fallback to legacy SSE for servers that predate the Streamable HTTP protocol). Configuration follows the industry-standard `mcpServers` shape and interoperates with Claude Code, Codex, and Cursor.

## Add

```sh
# stdio (everything after `--` is passed through to the server process)
volund mcp add context7 -- npx -y @context7/mcp
volund mcp add my-server -- node ./server.js --flag value
volund mcp add -e API_KEY=xxx context7 -- npx -y @context7/mcp

# Remote
volund mcp add -t http remote https://api.example.com/mcp
volund mcp add -t sse legacy https://old.example.com/sse
volund mcp add -t http -H 'Authorization: Bearer tok' remote https://api.example.com/mcp

# Project scope (.volund/mcp.toml, shipped with the repo)
volund mcp add -s project my-server -- npx -y my-mcp
```

`-e KEY=VALUE` and `-H 'Key: value'` can be repeated. Adding a name that already exists replaces the whole entry (no field merge).

You can also drop an industry-standard `.mcp.json` into the repo root — Volund imports it read-only at session start (it never writes that file):

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@context7/mcp"] },
    "remote": { "type": "http", "url": "https://api.example.com/mcp" }
  }
}
```

Environment expansion: values support `${VAR}` and `${VAR:-default}` (an unset variable without a default expands to an empty string with a warning). Prefer `keyref://` placeholders for credentials (`Authorization: keyref://mcp.<name>.Authorization`) instead of plaintext on disk.

## Configuration and scopes

Resolved in priority order (same name replaces the whole entry):

1. Project `<cwd>/.volund/mcp.toml` (TOML `[mcp_servers.<name>]` tables)
2. Project `<cwd>/.mcp.json` (industry JSON, read-only import)
3. User `~/.volund/mcp.toml`

Untrusted directories are rejected at startup and their project-level servers are never connected.

## Manage

| Action                        | REPL                                      | CLI                                                               |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| List / status                 | `/mcp` panel                              | `volund mcp list` (connectivity snapshot after a bounded 4s wait) |
| Detail                        | Enter in the panel (metadata + tool list) | `volund mcp inspect <name>`                                       |
| Enable / disable (persistent) | Space in the panel                        | `volund mcp enable\|disable <name>`                               |
| Connectivity test             | `r` in the panel (reconnect all)          | `volund mcp test <name>`                                          |
| OAuth login / logout          | —                                         | `volund mcp login\|logout <name>`                                 |
| Remove                        | —                                         | `volund mcp remove <name>`                                        |

The web console's Manage → MCP tab exposes the same flow as **Authenticate** / logout buttons on http/sse servers (embedded local console only). Login opens the browser on the host machine and blocks until the OAuth round-trip completes (up to 5 minutes); the needs-auth status flips to connected automatically afterwards.

Enabled state persists in `~/.volund/config.toml` under `[mcp] disabled`.

## Troubleshooting

- `~/.volund/mcp.log`: structured JSONL diagnostics (startup / connect / failure / per-line server stderr).
- `volund doctor`: the `mcp servers` row reports configured / connected / failed counts.
- A server returning 401/403 is marked `needs-auth` in the panel. Run `volund mcp login <name>` to start the OAuth flow (the token is stored in the credential store; `volund mcp logout <name>` clears it), click the **Authenticate** button in the web console's MCP tab, or configure an `Authorization` header / API-key env var manually.
