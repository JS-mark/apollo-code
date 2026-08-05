# L4 channel manifest dry-run

This procedure generates review-only Homebrew, winget, and apt/portable metadata from `channel-dry-run.json`. It never creates a tap/repository/account, signs an artifact, uploads a package, submits to winget, tags a commit, or creates a GitHub Release.

## Reproduce and validate

1. Replace only the fixture inputs after independently verifying the exact candidate version, HTTPS artifact URLs, SHA-256 values, license, dependencies, target mapping, and the linked L4 evidence decision.
2. Keep `evidenceGate.status` as `blocked` and every target below `Full` until an authorized release custodian supplies passing evidence for the exact artifacts.
3. Run `pnpm release:channels:generate`, inspect the diff under `docs/releases/channel-dry-run/`, then run `pnpm release:channels:check` twice. Identical output and digest are the reproducibility gate.
4. Verify the generated Formula with `ruby -c` when Ruby is available. Use winget schema validation and apt repository tooling only in an isolated, non-publishing environment. These optional tool checks do not constitute publication evidence.

## Authorization checklist

- Confirm the candidate commit, version, immutable URLs, and all eight archive digests.
- Confirm macOS signing/notarization, Windows trusted Authenticode, native sandbox escape, Linux glibc/musl execution, SBOM, LICENSE, and NOTICE evidence for the exact archives.
- Obtain explicit authorization separately for a Homebrew tap push, winget submission, and apt repository signing/upload. Credentials must be injected by the release custodian and never stored in fixtures or logs.
- Replace the dry-run disclosure only as part of that separately authorized release change. This repository does not auto-publish channel metadata.

## Rollback

Before publication, rollback is simply discarding the generated diff. After a real channel publication, stop further promotion, revoke or supersede the affected manifest in the channel's external repository, publish corrected checksums/version through its normal reviewed process, and retain incident evidence. Never overwrite an immutable release asset or silently reuse a version.
