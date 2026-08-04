## L3 external hardware evidence

### Windows Tier 3

| Target | Automation | Hardware result |
| --- | --- | --- |
| `x86_64-pc-windows-msvc` | Windows build and Tier 2 escape job | Tier 3 not executed in this changeset |
| `aarch64-pc-windows-msvc` | Windows ARM build and Tier 2 escape job | Tier 3 not executed in this changeset |

Do not promote either row to Full without an artifact containing the candidate
SHA, runner/architecture/OS, exact command, raw summary, exit code, and UTC
timestamps. A Windows Tier 3 job must additionally exercise default deny,
allowed and denied IPv4/IPv6 endpoints, DNS-answer pinning, concurrent session
isolation, transaction rollback, timeout cleanup, and crash recovery.

### AWS Graviton

`.github/workflows/graviton-evidence.yml` is a manual, secret-free sampling
workflow. It accepts only a full candidate SHA and runs only on an existing
controlled runner labelled `apollo-graviton`; it never creates paid resources.
Its artifact records the candidate and checked-out SHA, host, architecture,
kernel, exact command, raw summary, exit code, and start/end times.

Current hardware result: **not executed; waiting for an authorized external runner**.
