# @volund/remote-link

The local side of Volund remote control: an outbound "uplink" client that dials the public gateway (`@volund/gateway-server`) over WebSocket (`/uplink`) and exposes the machine's local `SessionHub` as a routable gateway instance. No inbound ports are opened — the connection is always dialed out.

## Responsibilities

- credentials: OAuth2 `client_credentials` exchange for a JWT, cached until near expiry and refreshed on reconnect;
- connection: WSS `/uplink` + `uplink.register` (active/pending snapshot), with exponential-backoff reconnect (1 s start, 30 s cap);
- bridging: gateway hub RPC → local `SessionHub`, and local events/state changes → gateway; the cwd gate is re-checked locally (`workspaceCwd`, with `realpath` against symlink escape);
- pairing: `pairing.create` / `devices.list` / `device.revoke` forwarded to the gateway.

`start()` is idempotent and configuration is re-read before every dial (`config()`), so `[remote]` changes take effect immediately. State is exposed as `off` / `connecting` / `online` with attempt and last-error details.

## Usage

The CLI assembles this package inside `apps/cli` (TUI/web remote control); there is no standalone command. Library use:

```ts
import { createRemoteLink } from '@volund/remote-link'

const link = createRemoteLink({
  config: () => ({ gatewayUrl, clientId, clientSecret }),
  hub, // local GatewayHubLike (SessionHub + model aliases)
  workspaceCwd,
})
await link.start()
```

## Documentation

- Gateway protocol and endpoints: [packages/gateway-server/PROTOCOL.md](../gateway-server/PROTOCOL.md)
- Remote gateway guide: [apps/docs/docs/guides/remote-gateway.md](../../apps/docs/docs/guides/remote-gateway.md)
- Gateway deployment: [deploy/gateway/README.md](../../deploy/gateway/README.md)
