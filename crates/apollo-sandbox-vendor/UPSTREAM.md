Upstream: https://github.com/openai/codex
Pinned commit: `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`
License: Apache-2.0

The reviewed L1 import boundary is recorded in `VENDOR.toml`. Apollo's current
adapter is intentionally dependency-minimal; upstream source is not copied into
the Cargo workspace until a source file is actually used. When a file is copied,
retain its header and update the inventory and digest in that manifest.
