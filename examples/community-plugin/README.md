# Community plugin example

This bundled single-file ESM example requests only `tools.register`; it has no filesystem or network permission.

```sh
npm pack --dry-run
apollo plugin install .
apollo plugin doctor apollo-plugin-community-example
apollo plugin disable apollo-plugin-community-example
apollo plugin enable apollo-plugin-community-example
apollo plugin uninstall apollo-plugin-community-example
```

Installation always requires an interactive permission confirmation. `npm publish` is intentionally outside this example and must not be run without release authorization.
