# Plugin host capability matrix

The executable source of truth is `APOLLO_BRIDGE_CAPABILITIES` in
`packages/plugin-runtime/src/index.ts`. CI verifies that it contains every leaf method from
`ApolloBridge`, that every row has a test entry point, and that unsupported methods explain why.

| Namespace           | Methods                                                         | Status      | Test entry                                                                                                           |
| ------------------- | --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| tools               | `register`, `unregister`                                        | supported   | `index.test.ts#ApolloBridge capability matrix`; real-host E2E covers registration, callback invocation, and disposal |
| hooks               | `on`, `off`, `kv.get`, `kv.set`, `kv.delete`, `kv.clear`        | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| commands            | `register`                                                      | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| prompt              | `contribute`, `revoke`                                          | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| session             | `getMessages`, `getUsage`, `on`                                 | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| fs                  | `readFile`, `writeFile`, `exists`, `glob`, `stat`               | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| process             | `exec`                                                          | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| http                | `fetch`                                                         | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| ui                  | `confirm`, `prompt`, `pick`, `notify`                           | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| storage             | `get`, `set`, `delete`                                          | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| memory              | `get`, `list`, `search`, `create`, `update`, `delete`, `export` | supported   | `index.test.ts#ApolloBridge capability matrix`; production writes use Memory ACL/preWrite and local audit            |
| config              | `get`                                                           | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| log                 | `debug`, `info`, `warn`, `error`                                | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| low-level transport | `call`                                                          | unsupported | Direct in-process dispatch is deliberately rejected by `index.test.ts#ApolloBridge capability matrix`                |
| provider/router     | `provider.register`                                             | unsupported | Declared by the provider-plugin design, but not exposed by `ApolloBridge` yet; policy tests cover the boundary       |
| provider auth       | `auth.getAuthHeaders`, `auth.getSigningEnvKeys`                 | unsupported | Declared by the provider-plugin design, but not exposed by `ApolloBridge` yet; policy tests cover the boundary       |

The Linux CI gate builds `apollo-sandbox` and runs `src/e2e.test.ts` with its path supplied through
`APOLLO_NATIVE_SANDBOX_BINARY`. The suite is opt-in outside that gate because macOS runners require
`sandbox-exec`, Windows plugin hosting is not yet supported, and arbitrary developer machines may not
have a native sandbox binary. Its suite title records this skip reason.

Memory access is separately declared in `manifest.permissions.memory` and in the Apollo RPC
allowlist. Read scopes are explicit (`workspace`, `project`, and/or `session`); search and export
require both their capability flag and read access to the requested scope. Writes require
`write: true` plus read access to the target scope, are re-scoped by the host to the current local
workspace/project/session, and cannot supply trusted provenance.
The host records metadata-only audit events. Memory export contains attachment references, never
attachment bytes, and no Memory bridge method uploads, shares, or performs network access.

## Production Memory hook contract

Plugins that combine `hooks.on` with at least one declared Memory read scope are loaded into one
process-wide Memory-policy runtime. This is the only runtime that dispatches Memory lifecycle hooks,
so multiple chat sessions do not duplicate policy execution and standalone CLI writes are covered.

- `memory.preWrite` runs for every create, update, delete, pin, unpin, and attachment-state mutation.
  The built-in validation and secret detector run first; policy runs before fact, index, or import
  journal mutation. Import preflight uses `phase: "validation"`; the committing call uses
  `phase: "commit"`.
- Only hooks whose declared Memory read scopes contain the exact event scope are invoked. Candidate
  content is available only on `memory.preWrite` after the secret guard accepts it.
  `memory.postWrite` and `memory.deleted` are metadata-only.
- Hook priority is a safe integer from -100 through 100. Hooks run by descending priority and then
  registration order. The first veto short-circuits the chain. Its sanitized,
  240-character-bounded reason is returned as `memory_hook_veto`.
- A pre-write exception, activation failure, or 10-second hook timeout fails closed as
  `memory_hook_failed`. A hook attempting a nested Memory write fails immediately; recursive policy
  evaluation is never entered.
- `memory.postWrite` runs after facts and the search index commit. `memory.deleted` follows it only
  for the first successful transition to a record tombstone. Observer failures are audited but
  cannot turn an already durable write into a reported failure.
- Disabled or uninstalled plugins are removed from the policy runtime before subsequent writes.
  Metadata-only attempts, accepts, vetoes, errors, and observer results are appended with mode 0600
  to `memory/hook-audit.jsonl`; Memory content is never written there.
