/**
 * volund-plugin-web-search — 内置插件：给 WebSearch 工具接上真实搜索后端。
 *
 * WebSearch 工具本体在 packages/tools，无 provider 时 fail-closed（no provider
 * configured）。本插件经 webSearch.provide 贡献搜索后端（tavily / brave /
 * custom），宿主适配成 WebSearchProvider 热接进共享工具实例——权限门、结果
 * 限长与 `<untrusted>` 包裹仍归工具本体，插件只提供数据源。
 *
 * 数据流：每次搜索宿主重读 [web_search] 配置段（backend / api key / custom_url）
 * 并随调用注入，插件据此选后端、经 volund.http.fetch（宿主网络出口，带代理栈；
 * tavily/brave 走 manifest net allowlist，custom_url 由宿主按「用户级配置亲自
 * 点名即授权」动态放行）调搜索 API，把响应归一成结构化结果数组。改配置即时
 * 生效，无需重启或重载插件。
 *
 * custom 后端契约：先 POST custom_url JSON `{query, max_results}`（配置了
 * custom_api_key 时附 `Authorization: Bearer <key>`），不行自动回退 GET 别名参数
 * `?q=&query=&max_results=&format=json`；响应接受顶层数组或 `{results:[…]}`，
 * 字段 title/url + snippet|content|description + 常见日期字段名——SearXNG、
 * Bing/Google 式 GET API、Tavily 兼容网关、自制服务都能接。
 *
 * /web-search 斜杠命令是配置面板：经 webSearch.configStatus（presence，不含
 * key 明文）展示当前配置，detail 给出 `volund config set` 的确切命令行；
 * web 控制台设置页同名段是另一端编辑面。
 *
 * TS 单文件入口（strip-types 可擦子集：interface / 类型标注可用，enum /
 * namespace / 参数属性不支持）；`import type` 只取 SDK 类型，沙箱里零依赖。
 * 装载链路与其余内置插件一致：volund-sandbox --run-plugin + fd3 桥；dev 态宿主
 * 以 Node ≥ 22.6 strip-types 直接装载 index.ts，产物由 rolldown 编译成 .mjs 分发
 * （见 rolldown.config.mjs 与 plugins/README.md）。
 */
import type { VolundBridge, WebSearchItem } from '@volund/plugin-sdk'

/** 每次搜索随调用注入的 [web_search] 配置快照（宿主侧已做过形状收敛）。 */
interface WebSearchConfig {
  backend?: string
  max_results?: number
  tavily_api_key?: string
  brave_api_key?: string
  custom_url?: string
  custom_api_key?: string
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
/** 错误信息里携带的响应体摘录上限（诊断 401/429 之类，不回传整个响应）。 */
const ERROR_BODY_EXCERPT = 200

/** 桥返回的 JSON 形态：宿主把响应体读成文本再过桥（沙箱内拿不到流）。 */
interface FetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

async function bridgeFetch(
  volund: VolundBridge,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
): Promise<FetchResult> {
  // 沙箱内拿不到流/AbortSignal：宿主侧执行请求（9s 封顶 + 900KB 帧限），
  // 响应体读成文本过桥。
  return (await volund.http.fetch(url, init)) as FetchResult
}

function httpError(backend: string, response: FetchResult): Error {
  const excerpt = response.body.slice(0, ERROR_BODY_EXCERPT).replaceAll(/\s+/g, ' ').trim()
  return new Error(
    `${backend} search failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
  )
}

/** 自定义后端的宽松字段归一：snippet/content/description 同义，日期字段名不挑。 */
function firstString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/** 从 {results:[…]} / 顶层数组响应里宽松归一出结果项；不可用返回空数组。 */
function parseCustomRows(payload: unknown): WebSearchItem[] {
  // 行数组提取：顶层数组 + 业界主流搜索 API 的原生包装形状——
  // {results}（Tavily/SearXNG 兼容）、{data}（通用 REST 惯例）、
  // {web:{results}}（Brave）、{organic_results}（SerpAPI/SearchAPI）、
  // {webPages:{value}}（Bing v7）、{items}（Google CSE）。
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (() => {
          const container = payload as Record<string, unknown>
          if (Array.isArray(container.results)) return container.results
          if (Array.isArray(container.data)) return container.data
          if (Array.isArray(container.items)) return container.items
          if (Array.isArray(container.organic_results)) return container.organic_results
          const web = container.web
          if (
            web &&
            typeof web === 'object' &&
            Array.isArray((web as { results?: unknown }).results)
          )
            return (web as { results: unknown[] }).results
          const webPages = container.webPages
          if (
            webPages &&
            typeof webPages === 'object' &&
            Array.isArray((webPages as { value?: unknown }).value)
          )
            return (webPages as { value: unknown[] }).value
          return []
        })()
      : []
  const items: WebSearchItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    const title = firstString(entry, ['title', 'name'])
    const urlValue = firstString(entry, ['url', 'link', 'href'])
    const snippet = firstString(entry, ['snippet', 'content', 'description', 'abstract', 'body'])
    if (!title || !urlValue || !snippet) continue
    const publishedAt = firstString(entry, [
      'publishedAt',
      'published_date',
      'publishedDate',
      'published',
      'date',
    ])
    items.push({
      title,
      url: urlValue,
      snippet,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    })
  }
  return items
}

const CUSTOM_CONTRACT_HINT =
  'expected POST JSON {query, max_results} or GET ?q=&format=json; body: a top-level array or ' +
  '{results|data|items|organic_results|web.results|webPages.value:[…]} with title/url and ' +
  'snippet|content|description (Tavily/SearXNG/Brave/SerpAPI/Bing/Google shapes accepted)'

async function searchCustom(
  volund: VolundBridge,
  query: string,
  limit: number,
  url: string,
  apiKey: string | undefined,
): Promise<WebSearchItem[]> {
  let endpoint: URL
  try {
    endpoint = new URL(url)
  } catch {
    throw new Error('web_search.custom_url is not a valid URL')
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
    throw new Error('web_search.custom_url must be an http(s) URL')
  // 主路径 POST JSON（Tavily 兼容网关/自制服务）；GET 型端点（SearXNG 的
  // ?q=&format=json、Bing/Google 式 ?q=）对 POST 常回 4xx 或非 JSON 页面，
  // 此时自动回退一发 GET 别名参数。两次都失败才报错（两次尝试都带进信息）。
  const failures: string[] = []
  const attempt = async (kind: 'POST' | 'GET'): Promise<WebSearchItem[]> => {
    const response =
      kind === 'POST'
        ? await bridgeFetch(volund, endpoint.href, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: { query, max_results: limit },
          })
        : await bridgeFetch(
            volund,
            `${endpoint.href}${endpoint.search ? '&' : '?'}q=${encodeURIComponent(query)}&query=${encodeURIComponent(query)}&max_results=${limit}&count=${limit}&num=${limit}&format=json`,
            {
              method: 'GET',
              headers: {
                accept: 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
              },
            },
          )
    if (response.status !== 200) throw httpError(`custom (${kind})`, response)
    let payload: unknown
    try {
      payload = JSON.parse(response.body)
    } catch {
      throw new Error(`custom (${kind}) endpoint returned a non-JSON body`)
    }
    const items = parseCustomRows(payload)
    if (items.length === 0)
      throw new Error(
        `custom (${kind}) endpoint returned no usable results — ${CUSTOM_CONTRACT_HINT}`,
      )
    return items
  }
  try {
    return await attempt('POST')
  } catch (postError) {
    failures.push(postError instanceof Error ? postError.message : String(postError))
  }
  try {
    return await attempt('GET')
  } catch (getError) {
    failures.push(getError instanceof Error ? getError.message : String(getError))
  }
  throw new Error(`custom search endpoint failed twice — ${failures.join(' | ')}`)
}

async function searchTavily(
  volund: VolundBridge,
  query: string,
  limit: number,
  apiKey: string,
): Promise<WebSearchItem[]> {
  const response = await bridgeFetch(volund, TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { api_key: apiKey, query, max_results: limit, include_answer: false },
  })
  if (response.status !== 200) throw httpError('tavily', response)
  const payload = JSON.parse(response.body) as {
    results?: { title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }[]
  }
  const items: WebSearchItem[] = []
  for (const entry of payload.results ?? []) {
    if (
      typeof entry.title !== 'string' ||
      typeof entry.url !== 'string' ||
      typeof entry.content !== 'string'
    )
      continue
    items.push({
      title: entry.title,
      url: entry.url,
      snippet: entry.content,
      ...(typeof entry.published_date === 'string' ? { publishedAt: entry.published_date } : {}),
    })
  }
  return items
}

async function searchBrave(
  volund: VolundBridge,
  query: string,
  limit: number,
  apiKey: string,
): Promise<WebSearchItem[]> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`
  const response = await bridgeFetch(volund, url, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
  })
  if (response.status !== 200) throw httpError('brave', response)
  const payload = JSON.parse(response.body) as {
    web?: {
      results?: {
        title?: unknown
        url?: unknown
        description?: unknown
        page_age?: unknown
        age?: unknown
      }[]
    }
  }
  const items: WebSearchItem[] = []
  for (const entry of payload.web?.results ?? []) {
    if (
      typeof entry.title !== 'string' ||
      typeof entry.url !== 'string' ||
      typeof entry.description !== 'string'
    )
      continue
    const publishedAt =
      typeof entry.page_age === 'string'
        ? entry.page_age
        : typeof entry.age === 'string'
          ? entry.age
          : undefined
    items.push({
      title: entry.title,
      url: entry.url,
      snippet: entry.description,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    })
  }
  return items
}

export async function activate(volund: VolundBridge): Promise<void> {
  // provider 贡献：宿主每次调用注入 [web_search] 快照（backend 未设置时宿主
  // 默认注入 tavily）；缺对应 key 时报带命令行的指引（错误信息直达工具结果，
  // 模型会转述给用户）。
  volund.webSearch?.provide({
    id: 'web-search',
    search: async (request, config) => {
      const { query, limit } = request
      const settings = config as WebSearchConfig
      if (settings.backend === 'tavily') {
        if (!settings.tavily_api_key)
          throw new Error(
            'web_search.tavily_api_key is not set — run: volund config set web_search.tavily_api_key <key> (backend defaults to "tavily" when web_search.backend is unset)',
          )
        return searchTavily(volund, query, limit, settings.tavily_api_key)
      }
      if (settings.backend === 'brave') {
        if (!settings.brave_api_key)
          throw new Error(
            'web_search.brave_api_key is not set — run: volund config set web_search.brave_api_key <key>',
          )
        return searchBrave(volund, query, limit, settings.brave_api_key)
      }
      if (settings.backend === 'custom') {
        if (!settings.custom_url)
          throw new Error(
            'web_search.custom_url is not set — run: volund config set web_search.custom_url <http(s) endpoint>',
          )
        return searchCustom(volund, query, limit, settings.custom_url, settings.custom_api_key)
      }
      throw new Error(
        'web search is not configured — set [web_search] backend = "tavily", "brave" or "custom" ' +
          '(custom also needs custom_url) and the matching API key in ~/.volund/config.toml, ' +
          'or use the settings UI (/web-search for details)',
      )
    },
  })

  // /web-search 配置面板：presence 视图 + 确切的配置命令行（选一条进 transcript）。
  await volund.commands.register({
    name: 'web-search',
    order: 56,
    description: 'Show [web_search] config status and how to change it',
    handler: async () => {
      let status: Record<string, unknown>
      try {
        if (!volund.webSearch)
          throw new Error('this host does not expose the webSearch bridge namespace')
        status = await volund.webSearch.configStatus()
      } catch (error) {
        return `/web-search is unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
      const backend =
        status.backend === 'tavily' || status.backend === 'brave' || status.backend === 'custom'
          ? status.backend
          : null
      const tavily = (status.tavily ?? {}) as { configured?: boolean }
      const brave = (status.brave ?? {}) as { configured?: boolean }
      const custom = (status.custom ?? {}) as { url?: string | null; apiKeyConfigured?: boolean }
      const maxResults = typeof status.max_results === 'number' ? status.max_results : null
      const entries = [
        {
          id: 'backend',
          label: 'backend',
          value: backend ?? 'unset (defaults to tavily)',
          status: backend ? 'configured' : 'not configured · defaults to tavily',
          detail: backend
            ? `web_search.backend = "${backend}"`
            : [
                'web_search.backend is not set — the search backend defaults to "tavily".',
                'Set web_search.tavily_api_key to enable, or pick another backend:',
                '',
                '  volund config set web_search.backend brave',
                '  volund config set web_search.backend custom',
              ].join('\n'),
        },
        {
          id: 'tavily_api_key',
          label: 'tavily_api_key',
          value: tavily.configured ? 'configured (hidden)' : 'unset',
          status: `required for backend=tavily · ${tavily.configured ? 'set' : 'missing'}`,
          detail: tavily.configured
            ? 'web_search.tavily_api_key is set (value never leaves the host).'
            : '  volund config set web_search.tavily_api_key <your-tavily-key>',
        },
        {
          id: 'brave_api_key',
          label: 'brave_api_key',
          value: brave.configured ? 'configured (hidden)' : 'unset',
          status: `required for backend=brave · ${brave.configured ? 'set' : 'missing'}`,
          detail: brave.configured
            ? 'web_search.brave_api_key is set (value never leaves the host).'
            : '  volund config set web_search.brave_api_key <your-brave-key>',
        },
        {
          id: 'custom_url',
          label: 'custom_url',
          value: custom.url ?? 'unset',
          status: `required for backend=custom · ${custom.url ? 'set' : 'missing'}`,
          detail: custom.url
            ? [
                `web_search.custom_url = "${custom.url}"`,
                'contract: POST JSON {query, max_results} (falls back to GET ?q=&format=json); body: array or {results|data|items|organic_results|web.results|webPages.value} with title/url + snippet|content|description — docs/reference/web-search-custom-backend',
              ].join('\n')
            : '  volund config set web_search.custom_url <http(s) endpoint>',
        },
        {
          id: 'custom_api_key',
          label: 'custom_api_key',
          value: custom.apiKeyConfigured ? 'configured (hidden)' : 'unset',
          status: 'optional for backend=custom (Bearer) · set/missing',
          detail: custom.apiKeyConfigured
            ? 'web_search.custom_api_key is set (value never leaves the host).'
            : '  volund config set web_search.custom_api_key <key>',
        },
        {
          id: 'max_results',
          label: 'max_results',
          value: maxResults === null ? 'unset (default 5)' : String(maxResults),
          status: 'optional · 1-10',
          detail: '  volund config set web_search.max_results 5',
        },
      ]
      return {
        kind: 'list',
        title: 'Web Search — [web_search] from ~/.volund/config.toml',
        placeholder: 'Search config keys',
        entries,
      }
    },
  })
  await volund.log.info('volund-plugin-web-search activated')
}
