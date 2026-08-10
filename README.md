# Apollo Code

<p align="center">
  <img src="apps/docs/public/apollo-mark.svg" alt="Apollo Code logo" width="112" />
</p>

<p align="center">
  <strong>A permission-first, provider-neutral coding agent for your terminal.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="apps/docs/index.md">Documentation</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" /></a>
  <a href="CONTRIBUTING.md"><img alt="Contributions welcome" src="https://img.shields.io/badge/contributions-welcome-brightgreen.svg" /></a>
  <img alt="Project status: early development" src="https://img.shields.io/badge/status-early_development-orange.svg" />
</p>

Apollo Code brings an agentic coding loop to the command line while keeping trust, permissions, credentials, and sandbox state visible. It is designed around explicit provider boundaries, recoverable file changes, machine-readable output, and native isolation helpers.

> [!IMPORTANT]
> Apollo Code is in active early development. A stable npm release has not been published; install it from source for evaluation and development. Interfaces and behavior may change before the first stable release.

## Table of contents

- [Why Apollo Code](#why-apollo-code)
- [What works today](#what-works-today)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration and security](#configuration-and-security)
- [How it fits together](#how-it-fits-together)
- [Development](#development)
- [Roadmap and project status](#roadmap-and-project-status)
- [Contributing and support](#contributing-and-support)
- [License](#license)

## Why Apollo Code

- **Permission-first execution** — directory trust is resolved before provider, tool, or session initialization; writes, commands, and network access remain separate approvals.
- **Provider-neutral architecture** — provider adapters and routing are explicit packages instead of assumptions embedded in the agent loop. Anthropic is the documented first-run provider today.
- **Native sandbox helpers** — Rust binaries provide platform-specific sandbox, search, and filesystem capabilities, with diagnostics through `apollo doctor`.
- **Recoverable sessions** — session history, resume boundaries, and guarded file restoration are part of the CLI surface.
- **Automation-friendly output** — chat supports versioned NDJSON events, while management commands return a single JSON document.
- **Extensible by design** — local plugins and skills have explicit manifests, permissions, namespaces, and runtime isolation.

## What works today

The current CLI includes:

- interactive Ink TUI and line-mode chat;
- one-shot prompts and NDJSON output for scripts;
- directory trust rules and project-configuration approval;
- provider credential login/logout with secure storage;
- permission checks, native sandbox integration, and runtime diagnostics;
- session history, resume, and guarded restore flows;
- local plugin install, enable, disable, diagnose, list, and uninstall commands;
- local telemetry inspection, redacted export, and clearing;
- configurable provider/model routing, including role-based candidates.

See the [CLI reference](apps/docs/docs/reference/cli.md) for the authoritative command surface and the [security model](apps/docs/docs/concepts/security-model.md) before using Apollo on sensitive repositories.

## Quick start

### Prerequisites

- Node.js 20.19 or newer
- pnpm 11.10.0 (declared through Corepack)
- Rust 1.71 or newer when building the native crates locally

### Build from source

```bash
git clone https://github.com/JS-mark/apollo-code.git
cd apollo-code
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/apollo.js --help
```

The workspace package version is currently `0.0.0`; it is not a published release. Follow the [installation guide](apps/docs/docs/getting-started/install.md) for release and native-binary details.

### Start your first session

```bash
node apps/cli/dist/apollo.js chat
```

On first use in a directory, Apollo asks you to trust the canonical workspace path before initializing the runtime. Choose Anthropic during onboarding and enter the credential only in Apollo's masked prompt, or authenticate explicitly:

```bash
node apps/cli/dist/apollo.js login anthropic
node apps/cli/dist/apollo.js doctor --strict
```

Read the [first-run guide](apps/docs/docs/getting-started/first-run.md) for trust scopes, headless behavior, and sandbox checks.

## Usage

Interactive chat is the default when stdin and stdout are terminals:

```bash
node apps/cli/dist/apollo.js
node apps/cli/dist/apollo.js chat
```

Force the line-mode fallback:

```bash
node apps/cli/dist/apollo.js chat --no-tui
```

Run a one-shot prompt and emit NDJSON without ANSI frames:

```bash
node apps/cli/dist/apollo.js chat "summarize this repository" --json
```

Inspect runtime state or manage a previous session:

```bash
node apps/cli/dist/apollo.js status --json
node apps/cli/dist/apollo.js history list
node apps/cli/dist/apollo.js resume <session-id>
node apps/cli/dist/apollo.js restore <session-id> --dry-run
```

Use `apollo help` or the [CLI reference](apps/docs/docs/reference/cli.md) for all commands. The [JSON output reference](apps/docs/docs/reference/json-output.md) documents the automation contract.

## Configuration and security

User configuration lives in `~/.apollo/config.toml`. Configuration layers are applied in this order: built-in defaults, global configuration, approved project configuration, environment values, then CLI flags. Project configuration is not loaded in non-interactive runs unless you pass `--trust-project-config`; sensitive routing, authentication, endpoint, and telemetry-sink keys are rejected from project configuration.

Example role routing in the trusted global configuration:

```toml
[router]
type = "role"

[router.default]
provider = "anthropic"
model = "claude-sonnet-4-5"

[router.roles.coder]
provider = "anthropic"
model = "claude-sonnet-4-5"
priority = 100
```

Security-relevant behavior:

- directory trust does not grant write, command, or network permission;
- headless runs fail on untrusted directories unless `--trust-workspace` is supplied explicitly;
- credentials are stored in the OS keychain or encrypted fallback store, not project files;
- `--dangerously-no-sandbox` requires explicit risk confirmation and is unsuitable for release acceptance;
- telemetry stays local unless an exporter is explicitly configured.

For details, see [directory trust and first run](apps/docs/docs/getting-started/first-run.md), the [security model](apps/docs/docs/concepts/security-model.md), and [sandbox troubleshooting](apps/docs/docs/troubleshooting/sandbox.md).

## How it fits together

```text
Terminal / automation
        │
        ▼
  apps/cli ──────── interactive UI, commands, JSON output
        │
        ▼
 packages/core ──── session and agent loop
   │      │      │
   │      │      └── tools, permissions, context, storage
   │      └───────── provider router and provider adapters
   └──────────────── plugin, skill, and MCP runtimes
        │
        ▼
 crates/* ───────── native sandbox, search, and filesystem helpers
```

The TypeScript packages keep the agent loop, providers, tools, permissions, storage, UI, plugins, and native bridge separated. The Rust workspace contains `apollo-sandbox`, `apollo-search`, and `apollo-fs`. For the detailed design, read the [architecture specification](docs/superpowers/specs/2026-07-31-apollo-code-design/README.md).

## Development

Install dependencies and run the standard local checks:

```bash
corepack enable
pnpm install --frozen-lockfile
cargo test --workspace
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Build optimized native binaries with `cargo build --workspace --release`. For local native diagnostics, build the Rust workspace and point Apollo to the three binaries:

```bash
cargo build --workspace
pnpm --filter apollo-code build
APOLLO_NATIVE_SANDBOX_BINARY="$PWD/target/debug/apollo-sandbox" \
APOLLO_NATIVE_SEARCH_BINARY="$PWD/target/debug/apollo-search" \
APOLLO_NATIVE_FS_BINARY="$PWD/target/debug/apollo-fs" \
node apps/cli/dist/apollo.js doctor --strict
```

An unavailable Anthropic credential can still make strict diagnostics fail after the native binaries build successfully. See [authentication troubleshooting](apps/docs/docs/troubleshooting/auth.md).

## Roadmap and project status

Apollo Code is progressing through repository-defined capability levels. The current public package is not released, and some future-facing design documents describe work beyond the shipped CLI. The implementation and tests are the source of truth.

Current planning and evidence are maintained in:

- the [milestone specification](docs/superpowers/specs/2026-07-31-apollo-code-design/10-milestones.md);
- [release readiness evidence](docs/releases/);
- the [capability traceability document](docs/superpowers/specs/2026-07-31-apollo-code-design/16-capability-traceability.md).

Notably, registry/GitHub plugin installation, plugin upgrades, and the L4 development hot-reload command are not implemented yet.

## Contributing and support

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and review [SECURITY.md](SECURITY.md) before reporting a vulnerability.

- Use [GitHub Issues](https://github.com/JS-mark/apollo-code/issues) for reproducible bugs and approved work.
- Use [GitHub Discussions](https://github.com/JS-mark/apollo-code/discussions) for questions and ideas, if Discussions is enabled for the repository.
- Follow the RFC process in the contribution guide for architecture, security, providers, or public API changes.

## License

Apollo Code is licensed under the [Apache License 2.0](LICENSE).
