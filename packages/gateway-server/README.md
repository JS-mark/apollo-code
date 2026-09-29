# @volund/gateway-server

The public remote gateway of Volund: a standalone HTTP relay that lets phones and machine clients control a desktop volund through an outbound uplink tunnel (topology: mobile → gateway (VPS) → `/uplink` tunnel → this machine). It has zero runtime dependencies — the RFC 6455 WebSocket handshake/frames and the HS256 JWT issuing/verification are implemented in this package on `node:http`/`node:crypto`.

## Endpoints

- auth: `POST /oauth/token` (OAuth2 `client_credentials` → HS256 JWT Bearer);
- relay data plane: `POST /v1/chat/completions` (OpenAI-compatible, SSE) and `GET /v1/ws` (interactive WebSocket session: approvals, interrupts, event stream);
- discovery and pairing: `GET /v1/instances`, `GET /v1/clients`, `GET /v1/models`, `GET /v1/tasks`, `GET /v1/tasks/runs`, `/v1/sessions` (list, transcript, changes, undo), `POST /v1/pairing` (mint machine enrollment codes), `POST /pairing/redeem` (device pairing, IP rate-limited);
- uplink: `GET /uplink` (outbound registration from a running volund, uplink scope);
- static: non-API paths serve the mobile station (same-origin, CSP nonce injected);
- health: `GET /healthz` / `GET /v1/health`.

Session model: volund is a single-runner runtime — turns queue through a FIFO and the gateway answers `409 gateway_session_busy` when the instance is busy.

## Run

Standalone relay entry (`volund-gateway` bin), without the volund CLI:

```bash
node packages/gateway-server/dist/bin.js [--port 8788] [--json]
```

Configuration comes from `GATEWAY_*` environment variables plus `VOLUND_HOME` (data root) and `VOLUND_MOBILE_ASSET_DIR` (mobile static override); client secret hashes, signing keys, and the paired-device registry live under `VOLUND_HOME/gateway/`. Docker deployment is covered in [deploy/gateway/README.md](../../deploy/gateway/README.md).

## Documentation

- Frame protocol and REST/WS contract: [PROTOCOL.md](PROTOCOL.md)
- Remote gateway guide: [apps/docs/docs/guides/remote-gateway.md](../../apps/docs/docs/guides/remote-gateway.md)
- Local side of the tunnel: [packages/remote-link/README.md](../remote-link/README.md)
