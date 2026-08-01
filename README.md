# Apollo Code

Apollo Code is an open-source, provider-neutral terminal coding agent. The repository is in the first implementation stage (L1); the executable CLI is not available yet.

## Development

Requirements: Node.js 20 or newer and pnpm 11.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The executable, provider integration, permissions, tools, storage, UI, and native sandbox will be added in subsequent L1 slices. The implementation contract lives in [`docs/superpowers/specs/2026-07-31-apollo-code-design/README.md`](./docs/superpowers/specs/2026-07-31-apollo-code-design/README.md).
