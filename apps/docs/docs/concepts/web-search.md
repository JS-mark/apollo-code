# WebSearch security contract

`WebSearch` lives in packages/tools and fails closed without a provider ("no provider
configured"). Real search capability ships as the builtin plugin
`volund-plugin-web-search`: it contributes a search backend (tavily / brave) via
`webSearch.provide`, and the host adapts it into the shared tool instance. The
permission gate, result caps, and the `<untrusted>` wrapper stay in the tool itself —
the plugin is only a data source. The `MockWebSearchProvider` in the repository exists
solely for offline contract tests — it never touches the network, needs no API key,
and incurs no service cost.

## Configuration

Configuration lives in the user-level `~/.volund/config.toml` `[web_search]` section
(API keys are forbidden from project-level override). The plugin re-reads the section
on every search, so config changes apply immediately:

```toml
[web_search]
backend = "tavily"        # "tavily" | "brave" | "custom"
max_results = 5           # 1-10, default 5
tavily_api_key = "tvly-…" # required when backend=tavily
# brave_api_key = "…"     # required when backend=brave
# custom_url = "https://search.internal.example/query"  # required when backend=custom
# custom_api_key = "…"    # optional; sent as Authorization: Bearer
```

**Custom backend contract** (`backend = "custom"`): the plugin first POSTs JSON
`{query, max_results}` to `custom_url` (with `Authorization: Bearer <custom_api_key>`
when set); if that returns a non-2xx or non-JSON response it automatically retries
once with GET alias parameters. The contract is the shape agent-search APIs have
converged on (a `results` array), with tolerant parsing of the native SearXNG,
Brave, SerpAPI, Bing v7, and Google CSE shapes — the full request/response spec,
wrapper table, and server examples live in the
[Web Search custom backend reference](/docs/reference/web-search-custom-backend).
The endpoint host is allowed through the plugin network egress dynamically — writing
it into the user-level config counts as authorization (project-level override is
forbidden, same data-flow gate as `provider.*.baseUrl`).

Editing surfaces: the TUI `/web-search` panel (presence view plus exact
`volund config set` lines), the web console settings page "Web 搜索" section
(keys are write-only, never echoed), and `volund config set/unset`. With no backend
configured, every search fails closed with configuration guidance instead of silently
degrading.

Plugin network access goes through the host-controlled egress (the `http.fetch` bridge
method): HTTPS only, restricted to the manifest `permissions.net` allowlist
(api.tavily.com / api.search.brave.com, plus the configured `custom_url` host), responses capped at 900KB / 9 seconds, sharing
WebFetch's proxy stack (HTTPS_PROXY). The plugin sandbox itself has no network.

## Permissions and logging

Every query must pass the permission gate first. The permission request contains only
the provider identifier and the redacted query; execution logs record a short hash of
the query, the provider, and the result count — never the raw query, result bodies, or
credentials. The API key is injected into the plugin per search call only; it is never
persisted into plugin storage or logs.

Results keep the provider's return order with no hidden cross-provider ranking. Counts,
per-item summaries, and total characters are capped, and results are returned wrapped in
a sourced `<untrusted>` block; tag characters inside results are encoded so the wrapper
cannot be closed early. This marker tells the model to treat search results as data
rather than instructions — it does not replace the permission gate, WebFetch domain
allowlists, or SSRF protections.

A future provider that fetches result pages (rather than calling a structured search
API) must reuse WebFetch's canonical domain permission, per-hop DNS re-resolution,
private-network / metadata address rejection, redirect policy, and response limits — it
must not bypass those primitives.
