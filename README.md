# Apollo Code

Apollo Code is an open-source, provider-neutral terminal coding agent. The repository is in the first implementation stage (L1); the local CLI is built from `apps/cli`.

## Development

Requirements: Node.js 20 or newer, pnpm 11, and Rust 1.71 or newer.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Rust and native binaries

The Rust workspace lives under `crates/*`:

- `apollo-sandbox`
- `apollo-search`
- `apollo-fs`

Build all Rust crates from the repository root:

```bash
cargo build --workspace
```

Build optimized native binaries:

```bash
cargo build --workspace --release
```

Build one native crate:

```bash
cargo build -p apollo-sandbox
cargo build -p apollo-search
cargo build -p apollo-fs
```

Run Rust tests:

```bash
cargo test --workspace
```

### Local verification

Use this sequence for a normal local check:

```bash
pnpm install
cargo test --workspace
pnpm typecheck
pnpm test
pnpm build
```

`apollo doctor --strict` checks runtime integrations in addition to build health.
When running from a local checkout, it can fail even after `cargo build` if the
CLI cannot find the native binaries or an Anthropic credential. That looks like:

```text
native sandbox unavailable
native search unavailable
native fs unavailable
anthropic credential unavailable
```

For local native testing, first compile the Rust binaries and point the CLI at
them:

```bash
cargo build --workspace
pnpm --filter apollo-code build
APOLLO_NATIVE_SANDBOX_BINARY="$PWD/target/debug/apollo-sandbox" \
APOLLO_NATIVE_SEARCH_BINARY="$PWD/target/debug/apollo-search" \
APOLLO_NATIVE_FS_BINARY="$PWD/target/debug/apollo-fs" \
node apps/cli/dist/apollo.js doctor --strict
```

If auth is the only remaining failing check, provide an Anthropic credential by
either exporting `ANTHROPIC_API_KEY` in your shell or logging in through the CLI:

```bash
export ANTHROPIC_API_KEY="..."
# or
node apps/cli/dist/apollo.js login anthropic
```

The implementation contract lives in [`docs/superpowers/specs/2026-07-31-apollo-code-design/README.md`](./docs/superpowers/specs/2026-07-31-apollo-code-design/README.md).
