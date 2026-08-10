# ADR 0007: CLI command architecture

Status: Accepted

## Context

The CLI entry point combines argument parsing, dispatch, domain behavior, presentation, and runtime construction. This makes command growth risky and requires editing a central conditional chain.

## Decision

CLI dependencies flow in one direction: `bin → app → commands → ports`. `runtime` is the composition root and implements ports; commands must never import it. Command domains must not import one another.

Each command exports a `CommandDefinition` containing a stable name and a handler. Handlers receive a typed `CommandContext` and return a typed `CliResult`. The app-level `CommandRegistry` owns lookup and dispatch. Presentation and IO adapters will move behind explicit interfaces as their command batches migrate.

Migration proceeds by behavior risk: metadata commands (`doctor`, `status`, `trust`, `telemetry`), integration commands (`plugin`, `mcp`, `context`, `evolution`), then stateful commands (`chat`, `auth`, `session`) and runtime factories. The compatibility `runCli` facade remains until the last batch is complete.

Existing names, flags, defaults, stdout/stderr, JSON schemas, exit codes, trust, permissions, signals, streaming, and redaction are compatibility constraints. Behavior changes require a separate RFC.

## New command template

1. Add `commands/<domain>/index.ts` exporting a `CommandDefinition`.
2. Express infrastructure needs through a narrow port; do not instantiate adapters in the handler.
3. Return `CliResult`; keep serialization in presentation code.
4. Register the definition in app composition and add handler, dispatch, and output assertions.
5. Extend the architecture test when adding a new command domain.

## Consequences

Commands can be tested with fake ports and added without new dispatch branches. During migration, the facade temporarily composes migrated commands alongside the legacy path. Architecture tests reject runtime imports and cross-domain command imports.
