# Bundled Bubblewrap payload

- Upstream: https://github.com/containers/bubblewrap
- Version: `0.11.2`
- Git commit: `1b80120ef26a28e065e67f89bfef873f13bdd317`
- Source license: LGPL-2.0-or-later (`LICENSE` and `COPYING` retained)
- Build container: `debian:bookworm-slim` (the manifest digest is pinned in
  `../../../scripts/rebuild-bwrap.sh`)

The minimal source inventory is copied without modification from the tagged
upstream release. `build.sh` produces non-setuid, architecture-specific glibc
payloads. The checked-in payloads are embedded into `apollo-sandbox`; their
SHA-256 values are pinned in `manifest.toml` and verified before every exec.

Run `crates/apollo-sandbox/scripts/rebuild-bwrap.sh --check` on a Docker host to
rebuild both Linux payloads and compare their digests and bytes.
