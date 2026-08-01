# L2 native target evidence

This table describes the verification implemented by the repository. It is not a release declaration.

| Target | Build/doctor lane | Escape evidence | Declared sandbox tier | External release gate |
|---|---|---|---|---|
| `aarch64-apple-darwin` | native | native | Partial | Apple notarization credentials and accepted notarization |
| `x86_64-apple-darwin` | native | native | Partial | Apple notarization credentials and accepted notarization |
| `x86_64-unknown-linux-gnu` | native | native | Full when bundled bwrap/user namespaces are available | none |
| `aarch64-unknown-linux-gnu` | cross/QEMU | partial-verified | probe-derived | real arm64 hardware escape run |
| `x86_64-unknown-linux-musl` | zig cross, host execution | cross-verified | probe-derived | Alpine compatibility run |
| `aarch64-unknown-linux-musl` | zig cross/QEMU | partial-verified | probe-derived | real arm64 Alpine hardware escape run |
| `x86_64-pc-windows-msvc` | native | foundation-verified refusal | None | Tier 1/2 implementation, native escape suite, Authenticode signature |
| `aarch64-pc-windows-msvc` | native | foundation-verified refusal | None | Tier 1/2 implementation, Windows-on-ARM escape suite, Authenticode signature |

The Windows foundation deliberately refuses command execution. It must not be described as Weak or Partial until Job Object + Restricted Token (Tier 1) and AppContainer ACL rollback (Tier 2) are implemented and verified. Windows Tier 3/WFP is outside L2.

No Authenticode signature or macOS notarization is claimed by this repository change. Those require release-candidate artifacts, certificate credentials, and the platform services; a stable L2 release remains blocked until those gates produce real evidence.
