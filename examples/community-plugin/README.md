# Community plugin example

This bundled single-file ESM example requests only `tools.register`; it has no filesystem or network permission.

The tool name is namespaced as `plugin:volund-plugin-community-example:community.echo`, as required for all plugin-contributed tools. The plugin is activated through the sandbox plugin chain and its handler always executes in the native sandbox host.

## Install through the `volund plugins` channel

Legacy `volund plugin install` temporarily fails closed (pending Catalog v2), so use the authoring toolchain instead. Both `volund plugins dev` and `volund plugins install` verify `engines.volund` in `manifest.json` against your CLI version and reject mismatches — the pinned `^0.0.0` will not match a current `0.x` CLI, so update it first (for example `"^0.2.0"`).

```sh
npm pack --dry-run
volund plugins build .
# -> ./volund-plugin-community-example-0.0.1.volund (sha256 printed)
volund plugins install ./volund-plugin-community-example-0.0.1.volund
```

`install` unpacks the `.volund` archive into `~/.volund/plugins-dev/`. The plugin then still requires explicit approval before activation: approve and enable it via the `/plugins` panel (or the web console plugin manager), and the tool becomes available in new sessions.

For iterative development, `volund plugins dev .` probe-activates the plugin in place, prints its contributions, and links the directory into `~/.volund/plugins-dev/` (restart the REPL to pick it up).

`npm publish` is intentionally outside this example and must not be run without release authorization.
