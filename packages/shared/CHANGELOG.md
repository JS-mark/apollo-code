# @apollo-code/shared

## 0.2.0

### Minor Changes

- ad0e7b5: Centralize every cross-module error code in an `ErrorCodes` registry (`error-codes.ts`) covering
  `error.raised` contract codes from appendix B.2, plugin, memory, provider/router, CLI `--json`,
  transport `APOLLO_*`, and testkit domains, with `ErrorCode` typing, appendix/normalized subsets,
  and a `pnpm verify:error-codes` drift check wired into the turbo `test` task so unregistered or
  zombie codes fail CI.
- 7d1147e: Add per-event payload zod schemas for the 19 EventBus events (spec appendix D): `EVENT_SCHEMAS` registry, shared envelope schema with UUIDv7 ids, and `eventEnvelopeFor(type)` replay validation. CI-enforced via `scripts/verify-event-schemas.mjs` against the §2.3 event table.
- 4ac2411: Config unknown-key policy (spec §8.3 / appendix C, r13-I4): full TOML `ConfigSchema` (strict zod objects + dynamic `provider.<name>` / `models.aliases.<alias>` catchalls), `configKeyRegistry` with per-key `projectOverride` annotations aligned to appendix C.2, and `projectOverrideFor`/`isProjectOverrideForbidden` helpers. `@apollo-code/config` gains `validateConfig`/`loadTomlFile` (unknown key → warn + ignore with key + file; known-key type error → `config_invalid` with file + key + expected type) and switches §8.3.1 project filtering to the registry (router.allow_cross_provider_tool_use now project-overridable per C.2). CI-enforced via `scripts/verify-config-docs.mjs` (`pnpm verify:config-docs`) against the appendix C.2 table.

## 0.1.0

### Minor Changes

- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- e6f71f1: Add the versioned extension transport protocol, resource and cancellation contracts, and the canonical normalized error taxonomy with redacted serialization.
- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.
- 344f874: Establish the L1 monorepo foundation, neutral provider and tool contracts, immutable session state, and the typed 17-event core bus.

### Patch Changes

- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
