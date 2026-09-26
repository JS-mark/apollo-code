# Web 搜索自定义后端 API

`volund-plugin-web-search` 的 `custom` 后端对接**你自己的** HTTP 端点。契约刻意
取智能体搜索行业已经收敛的形状——Tavily 兼容的请求 + `results` 数组响应——并对
SearXNG、Brave、SerpAPI/SearchAPI、Bing v7、Google CSE 的原生响应形状做宽容解析,
绝大多数现成搜索服务无需适配层直接可接。

## 配置

```toml
[web_search]
backend = "custom"                                    # 必填
custom_url = "https://search.internal.example/query"  # 必填
custom_api_key = "…"                                  # 可选
```

配置只允许写在**用户级** `~/.volund/config.toml`。`custom_url` 与所有
`*_api_key` 项目级禁止覆盖(`config_project_forbidden`)——clone 来的仓库不能把
你的 query 和 key 改指第三方。插件每次搜索重读该段,改配置即时生效,无需重启。

## 请求

插件**先 POST**,失败自动回退一次 GET:

| 尝试 | 形状                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------- |
| POST | `custom_url`,JSON 体 `{"query": "<query>", "max_results": N}`,`Content-Type: application/json`          |
| GET  | `custom_url?q=<query>&query=<query>&max_results=N&count=N&num=N&format=json`(别名参数覆盖常见 GET 方言) |

- **鉴权**:配置了 `custom_api_key` 时,两次尝试都带
  `Authorization: Bearer <custom_api_key>`;GET 另带 `Accept: application/json`。
  上游要别的鉴权头(如 Brave 的 `X-Subscription-Token`)时,在前面加一层极小的
  反代终结鉴权即可。
- POST 先行;返回非 2xx 或非 JSON 时用 GET 形状重试一次。两次都失败时,工具
  错误同时携带两条信息(HTTP 状态 + 200 字符响应摘录)便于诊断。
- 端点须在 ~9 秒内应答(宿主 fetch 超时);响应体须小于 900KB(桥帧上限)。

## 响应

HTTP 200 + JSON 体。插件从下列任一包装形状提取结果行,再对字段做宽容映射:

| 包装形状                             | 出处                          |
| ------------------------------------ | ----------------------------- |
| `[ … ]`(顶层数组)                    | 通用 JSON API                 |
| `{ "results": [ … ] }`               | Tavily、SearXNG 兼容          |
| `{ "data": [ … ] }`                  | 通用 REST 惯例                |
| `{ "items": [ … ] }`                 | Google Custom Search JSON API |
| `{ "organic_results": [ … ] }`       | SerpAPI / SearchAPI           |
| `{ "web": { "results": [ … ] } }`    | Brave Search API              |
| `{ "webPages": { "value": [ … ] } }` | Bing Web Search v7            |

每行字段取第一个命中的别名:

| 字段        | 接受的别名                                                            | 必填 |
| ----------- | --------------------------------------------------------------------- | ---- |
| title       | `title`、`name`                                                       | 是   |
| url         | `url`、`link`、`href`                                                 | 是   |
| snippet     | `snippet`、`content`、`description`、`abstract`、`body`               | 是   |
| publishedAt | `publishedAt`、`published_date`、`publishedDate`、`published`、`date` | 否   |

缺任一必填字段的行被静默跳过。如果**零条**可用结果,搜索 fail-closed 并附契约
提示——形状不对的端点会立刻暴露,而不是返回空答案。

## 最小服务端示例

```js
// Node http —— POST JSON 契约
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

每行形如 `{ "title": "…", "url": "https://…", "snippet": "…", "publishedAt": "2026-09-01" }`。

### SearXNG 说明

SearXNG 的 JSON API 在 `/search?q=…&format=json`(`settings.yml` 里开
`formats: [html, json]`)。`custom_url` 指向 `http://<host>:<port>/search` 即可——
POST 尝试返回 404/406,GET 回退直接命中 JSON API。SearXNG 的行形状
(`url`/`title`/`content`/`publishedDate`)原样可接。

## 安全说明

- 插件沙箱自身无网络;所有请求经宿主出口(代理栈,`HTTPS_PROXY` 生效),仅限
  `custom_url` 主机,9 秒 / 900KB 封顶。
- 权限门、结果限长、`<untrusted>` 包裹都在内置 WebSearch 工具侧——端点输出按
  不可信数据对待,永远不是指令。
- API key 只随单次搜索调用注入插件,不落插件存储、不进日志;web 设置页只显示
  presence(「已设置(不回显)」)。
