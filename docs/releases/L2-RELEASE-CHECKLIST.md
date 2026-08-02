# L2 release checklist

Status: **NOT RELEASED — external release gates remain blocked.**

This checklist separates repository implementation evidence from credentials,
real hardware, signing, notarization, and publication. Do not mark a stable L2
release complete from cross-build or self-signed smoke evidence.

## Repository gates

- [ ] Candidate is an immutable commit on a linear branch rebased on `main`.
- [ ] `pnpm turbo run typecheck test build --force` passes at the candidate revision.
- [ ] `pnpm docs:api` and the VitePress build pass without broken links.
- [ ] `pnpm release:status` reports the intended package bumps.
- [ ] Snapshot version dry-run passes in a disposable checkout.
- [x] Native platform manifest inventory is 24/24 (8 targets × sandbox/search/fs).
- [x] `apps/docs` is private and excluded from Changesets publication.
- [x] Weekly Renovate policy auto-merges CI-green non-major updates; majors require approval.
- [ ] Every releasable change has an reviewed changeset and release note.

## Target and Sandbox Tier disclosure

The detailed source of truth is `docs/releases/L2-NATIVE-TARGET-EVIDENCE.md`.

| Target group         | Current evidence    | Release disclosure                                              |
| -------------------- | ------------------- | --------------------------------------------------------------- |
| macOS arm64/x64      | 2/2 native fixtures | Partial; Apple notarization still blocked                       |
| Linux x64 GNU/musl   | 2/2 host fixtures   | Full only when the runtime probe confirms bwrap/user namespaces |
| Linux arm64 GNU/musl | 0/2 real hardware   | partial-verified under cross/QEMU; stable release blocked       |
| Windows x64/arm64    | 2/2 native Tier 2   | Partial; Tier 3 WFP is outside L2                               |

Any generated release notes must include each target's probe-derived Tier and
`escape.pass_ratio`; compilation alone is not Tier evidence.

## External human and credential gates

- [ ] **Linux arm64 real hardware — BLOCKED:** run GNU and Alpine arm64 escape suites and attach immutable logs/checksums.
- [ ] **Production Authenticode — BLOCKED:** a release custodian must sign the exact Windows candidate artifacts with a trusted publisher certificate and retain verification evidence. The CI self-signed smoke is not release evidence.
- [ ] **Apple notarization — BLOCKED:** a release custodian must Developer-ID sign, submit, receive acceptance, staple, and run `spctl` on the exact universal candidate artifacts.
- [ ] **Credentials — HUMAN GATE:** `NPM_TOKEN`, Apple credentials, and signing material must be supplied only through protected environments; never copy them into issues, logs, or repository files.
- [ ] **Real publication — HUMAN GATE:** an authorized release custodian approves the `npm-release` environment and verifies npm/GitHub Release results. This checklist does not authorize `npm publish`, tags, Releases, paid runners, or notarization submissions.

## Decision

Release status remains **BLOCKED** until every unchecked repository and external
gate has auditable evidence tied to the same candidate digest. A self-signed
certificate, QEMU run, available credential, or configured workflow is not a
substitute for production acceptance.
