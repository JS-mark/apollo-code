# @volund/mobile

The mobile station of Volund remote control: the phone side of the mobile → gateway → uplink topology. A Next.js static export (pure SPA, antd-mobile) with no backend of its own — pairing, sessions, chat, tasks, and changes all go straight to a public gateway (`@volund/gateway-server`) over REST and `/v1/ws`.

## Hosting

Two supported forms:

- same-origin: the gateway serves this app's static output itself (no CORS, default in the gateway Docker image);
- standalone: any static host — the `deploy/mobile` image, a CDN, or object storage. The pairing link carries `#pair=CODE&gw=<gateway>`, and the gateway address persists in `localStorage` for later visits.

## Build and run

```bash
pnpm --filter @volund/mobile dev     # http://localhost:3031
pnpm --filter @volund/mobile build   # static export into out/
```

Deployment assets (Docker image, compose, pairing topology, gateway `.env` settings) live in [deploy/mobile/README.md](../../deploy/mobile/README.md).

## Documentation

- Remote gateway guide: [apps/docs/docs/guides/remote-gateway.md](../docs/docs/guides/remote-gateway.md)
- Gateway deployment: [deploy/gateway/README.md](../../deploy/gateway/README.md)
