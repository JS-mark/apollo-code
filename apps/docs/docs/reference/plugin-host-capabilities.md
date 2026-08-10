# Plugin host capability matrix

The executable source of truth is `APOLLO_BRIDGE_CAPABILITIES` in
`packages/plugin-runtime/src/index.ts`. CI verifies that it contains every leaf method from
`ApolloBridge`, that every row has a test entry point, and that unsupported methods explain why.

| Namespace           | Methods                                                  | Status      | Test entry                                                                                                           |
| ------------------- | -------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| tools               | `register`, `unregister`                                 | supported   | `index.test.ts#ApolloBridge capability matrix`; real-host E2E covers registration, callback invocation, and disposal |
| hooks               | `on`, `off`, `kv.get`, `kv.set`, `kv.delete`, `kv.clear` | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| commands            | `register`                                               | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| prompt              | `contribute`, `revoke`                                   | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| session             | `getMessages`, `getUsage`, `on`                          | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| fs                  | `readFile`, `writeFile`, `exists`, `glob`, `stat`        | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| process             | `exec`                                                   | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| http                | `fetch`                                                  | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| ui                  | `confirm`, `prompt`, `pick`, `notify`                    | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| storage             | `get`, `set`, `delete`                                   | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| config              | `get`                                                    | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| log                 | `debug`, `info`, `warn`, `error`                         | supported   | `index.test.ts#ApolloBridge capability matrix`                                                                       |
| low-level transport | `call`                                                   | unsupported | Direct in-process dispatch is deliberately rejected by `index.test.ts#ApolloBridge capability matrix`                |
| provider/router     | `provider.register`                                      | unsupported | Declared by the provider-plugin design, but not exposed by `ApolloBridge` yet; policy tests cover the boundary       |
| provider auth       | `auth.getAuthHeaders`, `auth.getSigningEnvKeys`          | unsupported | Declared by the provider-plugin design, but not exposed by `ApolloBridge` yet; policy tests cover the boundary       |

The Linux CI gate builds `apollo-sandbox` and runs `src/e2e.test.ts` with its path supplied through
`APOLLO_NATIVE_SANDBOX_BINARY`. The suite is opt-in outside that gate because macOS runners require
`sandbox-exec`, Windows plugin hosting is not yet supported, and arbitrary developer machines may not
have a native sandbox binary. Its suite title records this skip reason.
