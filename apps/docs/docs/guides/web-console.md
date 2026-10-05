# Web console

Volund ships a local web console that starts **automatically and silently** when the TUI starts — there is no separate `volund web` command. It shares the same process, the same session, and the same approval queue as your terminal, so a decision on either end clears the card everywhere.

## Starting and stopping

- **Default**: on. Every `volund` TUI start prints the console address (loopback only, e.g. `http://127.0.0.1:<port>`).
- **Fixed port**: set `web.port` in `~/.volund/config.toml`. The console remembers the last port and falls back to a random one when it is taken.
- **Disable**: set `[web] enabled = false` in user config, or run once with `VOLUND_WEB=0`. A console failure never blocks the TUI — it surfaces as a startup notice.

## Security model

- **Loopback only**: the server binds `127.0.0.1`; nothing is reachable from the network.
- **Tokenless entry**: no URL token. On first visit the server auto-issues an HttpOnly `SameSite=Strict` session cookie plus a CSRF token; mutating requests require a matching same-site `Origin` and the `X-Volund-Csrf` header.
- **Hardened headers**: per-request CSP nonce (`script-src 'self'`, never `unsafe-inline`), `frame-ancestors 'none'`, and Host/Origin exact matching (DNS-rebinding resistant).
- **Server restart**: responses carry a `bootId`; clients detect a restart and clear stale state automatically.

## What's in it

| Area     | Highlights                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat     | Streaming replies, approval cards, ask cards, image attachments, **send queue** (messages typed mid-turn queue up and auto-send in order; drag to reorder) |
| Code     | Workbench file tree, Monaco editor saves (pre-write backup rides the session undo pipeline), interactive terminal over WebSocket                           |
| Status   | Session status panel, `/status` tabs contributed by plugins                                                                                                |
| Manage   | MCP servers (add/inspect/enable/**Authenticate** via OAuth), skills (install/market), memory editor, plugin manager                                        |
| Tasks    | Scheduled task definitions and run journal (read-only over the remote gateway)                                                                             |
| Subagents | Subagent run registry (status/usage/duration); running entries can be cancelled (tunneled over the remote gateway)                                        |
| Remote   | Gateway pairing, device management, remote-control status                                                                                                  |
| Settings | Config view/edit, shortcuts, session statistics                                                                                                            |

## Configuration keys

```toml
[web]
enabled = true          # false disables autostart
port = 3777             # 0 = remember last / random fallback

[web.terminal]
shell = "/bin/zsh"      # workbench terminal shell
font_size = 13
scrollback = 5000
```

All keys are user-level (`projectOverride: forbidden` for credential-adjacent faces; `web.*` is local-device surface). The asset directory can be overridden with `VOLUND_WEB_ASSET_DIR` for development.

## Troubleshooting

- **White page after upgrade**: old hashed assets cached — hard-refresh (the server marks `index.html` no-store precisely to avoid this; a stale proxy in front can still pin it).
- **"Assets are not built" placeholder**: your distribution lacks the console bundle — npm/standalone packages ship it since 0.2.x; dev builds need `pnpm --filter @volund/web build`.
- **Approvals don't pop on the web side**: the TUI owns permission interaction mode; the console mirrors the shared queue. If the TUI was started with `--yolo`, nothing queues anywhere.
