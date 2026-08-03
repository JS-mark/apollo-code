# ADR: Distribute native binaries with GitHub Releases

Status: Accepted, 2026-08-03.

## Decision

Apollo publishes the 8-target × 3-capability native matrix as immutable GitHub Release assets. Native binaries are not separate npm packages and `native-bridge` has no platform `optionalDependencies`.

Each version tag publishes one asset per capability and target, for example `apollo-sandbox-linux-x64-gnu`, plus a `checksums.sha256` manifest. Windows assets use `.exe`. The runtime derives the target from `process.platform`, `process.arch`, and Linux libc; downloads only from the exact application version; verifies SHA-256; stores the executable in a versioned cache; and retains the existing safe fallback when an asset is unavailable. `APOLLO_NATIVE_*_BINARY` remains the explicit development and CI override.

## Consequences

- The repository no longer contains `platforms/*` package manifests.
- Changesets versions JavaScript packages only. Creating a version tag triggers the native matrix and Release upload after its license, doctor, signing-smoke, notarization-gate, and reproducibility dependencies complete.
- First native use may require network access. Offline deployments must pre-seed the cache or provide the existing binary override.
- The 8 native and 8 sandbox-escape validation matrix, Tier disclosures, production signing, notarization, and real-hardware gates are unchanged.

This ADR supersedes the npm platform-package and `optionalDependencies` distribution passages in `01-repo-layout.md`, `05-rust-sidecar.md`, `09-build-ci-dist.md`, `10-milestones.md`, `SANDBOX-COMPAT-r1.md`, and the L1 checklist. Historical review documents remain unchanged as records of earlier decisions.
