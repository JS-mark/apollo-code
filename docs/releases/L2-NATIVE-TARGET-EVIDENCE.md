# L2 native target evidence

This table describes the verification implemented by the repository. It is not a release declaration.

| Target                       | Build/doctor lane         | Escape evidence             | Declared sandbox tier                                 | External release gate                                                        |
| ---------------------------- | ------------------------- | --------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `aarch64-apple-darwin`       | native                    | native                      | Partial                                               | Apple notarization credentials and accepted notarization                     |
| `x86_64-apple-darwin`        | native                    | native                      | Partial                                               | Apple notarization credentials and accepted notarization                     |
| `x86_64-unknown-linux-gnu`   | native                    | native                      | Full when bundled bwrap/user namespaces are available | none                                                                         |
| `aarch64-unknown-linux-gnu`  | cross/QEMU                | partial-verified            | probe-derived                                         | real arm64 hardware escape run                                               |
| `x86_64-unknown-linux-musl`  | zig cross, host execution | cross-verified              | probe-derived                                         | Alpine compatibility run                                                     |
| `aarch64-unknown-linux-musl` | zig cross/QEMU            | partial-verified            | probe-derived                                         | real arm64 Alpine hardware escape run                                        |
| `x86_64-pc-windows-msvc`     | native                    | foundation-verified refusal | None                                                  | Tier 1/2 implementation, native escape suite, Authenticode signature         |
| `aarch64-pc-windows-msvc`    | native                    | foundation-verified refusal | None                                                  | Tier 1/2 implementation, Windows-on-ARM escape suite, Authenticode signature |

The Windows foundation deliberately refuses command execution. It must not be described as Weak or Partial until Job Object + Restricted Token (Tier 1) and AppContainer ACL rollback (Tier 2) are implemented and verified. Windows Tier 3/WFP is outside L2.

No Authenticode signature or macOS notarization is claimed by this repository change. Those require release-candidate artifacts, certificate credentials, and the platform services; a stable L2 release remains blocked until those gates produce real evidence.

## Signing evidence semantics

The native workflow exercises Authenticode with an ephemeral self-signed CI certificate. This proves only that the produced PE files can be signed and that Windows can verify that temporary signature in the creating user's certificate store. It is not a trusted publisher signature and must never be used as stable-release evidence.

The macOS lane records whether the three notarization credentials are available, but deliberately does not submit development artifacts. A release workflow must sign the final universal binaries with the release Developer ID identity, submit those exact artifacts to Apple's notary service, wait for acceptance, staple the ticket, and verify with `spctl`. Until that evidence exists, notarization remains an external blocking gate.

## Current pass ratios

| Target group |         Native/escape result represented by this repository |             Ratio | Disclosure                                                                             |
| ------------ | ----------------------------------------------------------: | ----------------: | -------------------------------------------------------------------------------------- |
| macOS native |             required fixture executes on both architectures |               2/2 | Partial tier; notarization blocked externally                                          |
| Linux x64    |            GNU and musl fixtures execute on the host kernel |               2/2 | Full only when runtime probe confirms bwrap/user namespaces                            |
| Linux arm64  |              binaries and QEMU-limited behavior are checked | 0/2 real hardware | Partial-verified; stable release blocked on hardware                                   |
| Windows      | fail-closed foundation checks execute on both architectures |      0/2 Tier 1/2 | Weak/Partial must not be claimed; Authenticode production signature blocked externally |
