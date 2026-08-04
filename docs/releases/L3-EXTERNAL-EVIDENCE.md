## L3 external hardware evidence

### Windows Tier 3

| Target                    | Automation                              | Hardware result                       |
| ------------------------- | --------------------------------------- | ------------------------------------- |
| `x86_64-pc-windows-msvc`  | Windows build and Tier 2 escape job     | Tier 3 not executed in this changeset |
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

## Community plugin local dog-food

Candidate implementation SHA: `5add9f5647ab604d5c65b1e6de4b32a14169834a`.

Executed locally on macOS arm64 on 2026-08-04 (Asia/Shanghai), with an isolated `APOLLO_HOME` and redacted output:

| Step                 | Command                                                                     | Exit | Result                                                         |
| -------------------- | --------------------------------------------------------------------------- | ---: | -------------------------------------------------------------- |
| Pack/publish preview | `pnpm --dir examples/community-plugin pack:dry-run`                         |    0 | Four expected files; no publish performed                      |
| Local install        | `node apps/cli/dist/apollo.js plugin install examples/community-plugin`     |    0 | Explicit `tools.register` approval accepted; installed `0.0.1` |
| Inspect              | `plugin list --json`; `plugin doctor apollo-plugin-community-example`       |    0 | Enabled state and declared permission matched                  |
| Lifecycle            | `plugin disable`; `plugin enable`; `plugin uninstall`; `plugin list --json` |    0 | State transitions succeeded; final list empty                  |

The host reported Sandbox Tier `NONE` because the native sandbox binary was unavailable on this machine. Consequently, plugin activation/execution is **not claimed** by this evidence: only packaging and the local CLI lifecycle were executed. This degraded run is not release acceptance evidence. No npm publish, tag, GitHub Release, production signing, real-provider call, Windows Tier 3 run, or Graviton run was performed.
