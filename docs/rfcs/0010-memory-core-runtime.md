# ADR 0010: Memory core runtime and persistence

Status: Accepted

## Context

Memory needs one durable model shared by later CRUD, recall, CLI, and TUI work. Direct filesystem access from those consumers would duplicate scope and recovery rules.

## Decision

`@apollo-code/storage` owns the versioned `MemoryRecord`, the service/repository/policy ports, and a local atomic-snapshot repository. Records carry an explicit workspace, project, or session scope; provenance, normalized tags, pin state, timestamps, and a soft-delete timestamp. Scope equality is fail-closed at every read and mutation.

The local adapter writes a temporary file, fsyncs it, rotates the last valid snapshot to `.bak`, atomically renames the temporary file, and fsyncs the directory. Startup falls back to the backup after a corrupt or interrupted primary write. Schema dispatch is centralized in the loader so future versions can add migrations without leaking persistence details into the service.

The production CLI composition root creates exactly one `MemoryService` and exposes it through `ApolloPorts`. A successful mutation is durable before it resolves; `flush()` remains the explicit shutdown boundary and waits for queued writes.

## Consequences

Later interfaces depend only on `MemoryService`. The first schema uses JSON snapshots for deterministic recovery and migration; indexing and external synchronization remain separate adapters and are intentionally out of scope.
