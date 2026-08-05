# Windows EV Authenticode and Microsoft Store migration

Status: authorization-gated plan for APO-63. CI implements fixture/self-signed verification only. No organization validation, certificate purchase, production signing, Partner Center account creation, Store upload, or paid action has been performed.

## Trust and release contract

Release candidates are immutable outputs of the x64 and arm64 standalone builds. Build first, record the unsigned SHA-256 and SBOM, sign through an organization-controlled HSM or managed signing service, then verify the signature, RFC 3161 timestamp, architecture, signed SHA-256, SBOM linkage, and provenance attestation before any publication step. A signed artifact is a new artifact: the unsigned and signed digests must differ and both remain in the evidence record.

The production signer must use an EV code-signing identity issued after CA organization validation. Private key export is forbidden. Prefer managed signing with workload OIDC; otherwise use a FIPS-capable organization HSM. Static PFX files, repository secrets containing keys, interactive developer signing, and credentials printed to logs are prohibited. The signing principal receives only sign/read-status permissions for the scoped certificate profile. Publishing uses a separate identity and cannot sign.

Two distinct humans approve the release candidate and signing operation through a protected production environment. The build identity cannot approve itself. Approval evidence includes the change-control ID, candidate commit, workflow run, unsigned digest set, signer identity, certificate thumbprint/serial, timestamp authority, signed digest set, SBOM digest, attestation digest, and verification output. Logs pass secret redaction and are retained with release evidence according to the organization's release-record policy.

## External decisions and costs

Before enabling production, the owner must explicitly authorize: CA/vendor selection and recurring price; legal organization-validation contact; managed-signing/HSM tenant and region; Microsoft Partner Center account and fee; publisher display name and Store identity; retention period; and named release custodians. Procurement, account creation, identity verification, tenant configuration, and Store submission happen outside this repository.

The recommended order is: approve vendor and budget; complete organization validation; create non-exportable key custody; configure OIDC federation restricted to this repository, protected environment, ref, and workflow; assign least-privilege signing role; record CA chain and RFC 3161 endpoint; execute a quarantined candidate signing; verify on clean x64 and arm64 Windows hosts; then separately authorize channel publication.

## Microsoft Store compatibility

Package both architectures as MSIX with a stable Package/Identity Name, Publisher matching Partner Center exactly, semantic version, executable alias, capabilities limited to actual requirements, and no certificate material. Validate install, launch, sandbox doctor output, same-family upgrade with data preservation, downgrade rejection, clean uninstall, and uninstall/reinstall. Store signing does not replace verification of the upstream Authenticode candidate, SBOM, or attestation.

Channel manifests (Store/winget) pin the final signed digest and version. `verify-before-publish` must complete before a publish identity is available. A successful self-signed smoke, fixture result, cross-build, or Store ingestion must never satisfy the trusted-publisher gate.

## Rotation, revocation, and rollback

Inventory certificate expiry and alert at 120/90/60/30 days. Rotation creates a new non-exportable key, repeats organization and clean-host validation, dual-verifies during an overlap window, updates the allowed certificate profile, then disables the old signer. Never reuse revoked material.

On suspected compromise: disable the signing identity and OIDC federation, revoke the certificate, stop all channel jobs, preserve audit logs, identify every digest signed since last-known-good, publish a security advisory, withdraw affected Store/channel versions where supported, and republish only from a clean commit with new custody. Rollback selects a previously verified signed digest; it never re-signs mutable bytes under an old version.

## Threat model

| Threat | Prevent / detect | Fail-closed response |
| --- | --- | --- |
| Key theft or export | HSM/managed signer, no PFX, OIDC, least privilege | Disable federation, revoke, incident process |
| Unapproved signing | protected environment and two-person approval | Missing approval rejects evidence |
| Artifact swap after build | unsigned/signed SHA-256, SBOM and attestation binding | Digest mismatch blocks publication |
| Wrong architecture/package | verifier requires one x64 and one arm64 artifact | Missing/duplicate/mismatched architecture blocks |
| Invalid/revoked chain | clean-host chain and offline revoked-fixture tests | Verification outcome other than valid blocks |
| Timestamp substitution | pinned HTTPS RFC 3161 service and timestamp verification | Missing/mismatched timestamp blocks |
| Log credential disclosure | no static credential, structured redaction marker | Unredacted evidence blocks |
| Store identity takeover | exact Partner Center identity check, separate publisher role | Identity mismatch blocks submission |

## Authorization checklist

- [ ] Owner approved vendor, budget, account creation, and legal organization validation.
- [ ] Security approved HSM/managed custody, OIDC claims, roles, and two-person environment protection.
- [ ] Release engineering validated x64/arm64 clean-host signing, timestamps, digest/SBOM/attestation binding, and redacted logs.
- [ ] Store owner approved Partner Center identity, MSIX manifest, upgrade/uninstall tests, and channel rollback.
- [ ] Incident owner rehearsed disable, revoke, inventory, withdrawal, rotation, and clean republish.
- [ ] A separate explicit authorization permits the specific production signing run.
- [ ] A separate explicit authorization permits the specific Store/channel publication.

Until every item is complete, production EV signing and Store publication remain **BLOCKED**.
