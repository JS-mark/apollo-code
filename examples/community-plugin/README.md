# Community plugin example

This bundled single-file ESM example requests only `tools.register`; it has no filesystem or network permission.

The tool name is namespaced as `plugin:apollo-plugin-community-example:community.echo`, as required for all plugin-contributed tools. Apollo activates it only after installation and explicit permission approval, and executes its handler in the native sandbox host.

```sh
npm pack --dry-run
apollo plugin install .
apollo plugin doctor apollo-plugin-community-example
apollo plugin disable apollo-plugin-community-example
apollo plugin enable apollo-plugin-community-example
apollo plugin uninstall apollo-plugin-community-example
```

Installation always requires an interactive permission confirmation. `npm publish` is intentionally outside this example and must not be run without release authorization.
