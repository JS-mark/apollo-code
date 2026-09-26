# Web Search custom backend API

The `custom` backend of `volund-plugin-web-search` talks to **your** HTTP endpoint.
The contract is deliberately the shape the agent-search industry has converged on —
a Tavily-compatible request with a `results` array — plus tolerant parsing of the
native response shapes of SearXNG, Brave, SerpAPI/SearchAPI, Bing v7, and Google
CSE, so most existing search services work without an adapter.

## Configuration

```toml
[web_search]
backend = "custom"                                    # required
custom_url = "https://search.internal.example/query"  # required
custom_api_key = "…"                                  # optional
```

Keys live in the **user-level** `~/.volund/config.toml` only. `custom_url` and
every `*_api_key` are forbidden from project-level override (`config_project_forbidden`),
so a cloned repository cannot redirect your queries or key to a third party. The
plugin re-reads the section on every search — config changes apply immediately,
no restart.

## Request

The plugin tries **POST first**, then falls back to **GET once**:

| Attempt | Shape                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| POST    | `custom_url` with JSON body `{"query": "<query>", "max_results": N}` and `Content-Type: application/json`                     |
| GET     | `custom_url?q=<query>&query=<query>&max_results=N&count=N&num=N&format=json` (alias parameters cover the common GET dialects) |

- **Auth**: when `custom_api_key` is set, both attempts send
  `Authorization: Bearer <custom_api_key>`. GET attempts also send
  `Accept: application/json`. If your upstream needs a different auth header
  (e.g. Brave's `X-Subscription-Token`), terminate auth in front of it with a
  tiny reverse proxy.
- The POST is attempted first; if it returns a non-2xx status or a non-JSON
  body, the plugin retries once with the GET shape. If both fail, the tool error
  includes both messages (HTTP status + a 200-char body excerpt) for diagnosis.
- Endpoint must answer within ~9 seconds (host fetch timeout); the response body
  must stay under 900KB (bridge frame limit).

## Response

HTTP 200 with a JSON body. The plugin extracts the result rows from any of these
wrapper shapes, then maps fields leniently:

| Wrapper                              | Known from                    |
| ------------------------------------ | ----------------------------- |
| `[ … ]` (top-level array)            | generic JSON APIs             |
| `{ "results": [ … ] }`               | Tavily, SearXNG-compatible    |
| `{ "data": [ … ] }`                  | generic REST convention       |
| `{ "items": [ … ] }`                 | Google Custom Search JSON API |
| `{ "organic_results": [ … ] }`       | SerpAPI / SearchAPI           |
| `{ "web": { "results": [ … ] } }`    | Brave Search API              |
| `{ "webPages": { "value": [ … ] } }` | Bing Web Search v7            |

Per row, the first present alias wins:

| Field       | Accepted aliases                                                      | Required |
| ----------- | --------------------------------------------------------------------- | -------- |
| title       | `title`, `name`                                                       | yes      |
| url         | `url`, `link`, `href`                                                 | yes      |
| snippet     | `snippet`, `content`, `description`, `abstract`, `body`               | yes      |
| publishedAt | `publishedAt`, `published_date`, `publishedDate`, `published`, `date` | no       |

Rows missing any required field are skipped silently. If **zero** usable rows
come back, the search fails closed with the contract hint — so a wrong-shaped
endpoint surfaces immediately instead of returning empty answers.

## Minimal server example

```js
// Node http — POST JSON contract
import { createServer } from 'node:http'
createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const { query, max_results = 5 } = JSON.parse(body || '{}')
    const rows = mySearch(query).slice(0, max_results)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: rows }))
  })
}).listen(8787)
```

Each row: `{ "title": "…", "url": "https://…", "snippet": "…", "publishedAt": "2026-09-01" }`.

### SearXNG note

SearXNG serves its JSON API at `/search?q=…&format=json` (enable `formats: [html, json]`
in `settings.yml`). Point `custom_url` at `http://<host>:<port>/search` — the POST
attempt returns 404/406 and the GET fallback lands on the JSON API directly. The
SearXNG row shape (`url`/`title`/`content`/`publishedDate`) is accepted as-is.

## Security notes

- The plugin sandbox itself has no network; every request goes through the host
  egress (proxy stack honored via `HTTPS_PROXY`), restricted to your `custom_url`
  host, 9s / 900KB capped.
- The permission gate, result caps, and the `<untrusted>` wrapper stay in the
  built-in WebSearch tool — your endpoint's output is treated as untrusted data,
  never instructions.
- The API key is injected into the plugin per search call only; it is never
  written to plugin storage or logs. The web settings UI shows presence only
  ("已设置（不回显）").
