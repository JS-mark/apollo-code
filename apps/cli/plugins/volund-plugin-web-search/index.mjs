const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
/** 错误信息里携带的响应体摘录上限（诊断 401/429 之类，不回传整个响应）。 */
const ERROR_BODY_EXCERPT = 200
async function bridgeFetch(volund, url, init) {
  // 沙箱内拿不到流/AbortSignal：宿主侧执行请求（9s 封顶 + 900KB 帧限），
  // 响应体读成文本过桥。
  return await volund.http.fetch(url, init)
}
function httpError(backend, response) {
  const excerpt = response.body.slice(0, ERROR_BODY_EXCERPT).replaceAll(/\s+/g, ' ').trim()
  return new Error(
    `${backend} search failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ''}`,
  )
}
/** 自定义后端的宽松字段归一：snippet/content/description 同义，日期字段名不挑。 */
function firstString(entry, keys) {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}
/** 从 {results:[…]} / 顶层数组响应里宽松归一出结果项；不可用返回空数组。 */
function parseCustomRows(payload) {
  // 行数组提取：顶层数组 + 业界主流搜索 API 的原生包装形状——
  // {results}（Tavily/SearXNG 兼容）、{data}（通用 REST 惯例）、
  // {web:{results}}（Brave）、{organic_results}（SerpAPI/SearchAPI）、
  // {webPages:{value}}（Bing v7）、{items}（Google CSE）。
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (() => {
          const container = payload
          if (Array.isArray(container.results)) return container.results
          if (Array.isArray(container.data)) return container.data
          if (Array.isArray(container.items)) return container.items
          if (Array.isArray(container.organic_results)) return container.organic_results
          const web = container.web
          if (web && typeof web === 'object' && Array.isArray(web.results)) return web.results
          const webPages = container.webPages
          if (webPages && typeof webPages === 'object' && Array.isArray(webPages.value))
            return webPages.value
          return []
        })()
      : []
  const items = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row
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
async function searchCustom(volund, query, limit, url, apiKey) {
  let endpoint
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
  const failures = []
  const attempt = async (kind) => {
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
    let payload
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
async function searchTavily(volund, query, limit, apiKey) {
  const response = await bridgeFetch(volund, TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { api_key: apiKey, query, max_results: limit, include_answer: false },
  })
  if (response.status !== 200) throw httpError('tavily', response)
  const payload = JSON.parse(response.body)
  const items = []
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
async function searchBrave(volund, query, limit, apiKey) {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`
  const response = await bridgeFetch(volund, url, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
  })
  if (response.status !== 200) throw httpError('brave', response)
  const payload = JSON.parse(response.body)
  const items = []
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
export async function activate(volund) {
  // provider 贡献：宿主每次调用注入 [web_search] 快照；未配置时 fail-closed
  // 并给出指引（错误信息直达工具结果，模型会转述给用户）。
  volund.webSearch?.provide({
    id: 'web-search',
    search: async (request, config) => {
      const { query, limit } = request
      const settings = config
      if (settings.backend === 'tavily') {
        if (!settings.tavily_api_key)
          throw new Error(
            'web_search.tavily_api_key is not set — run: volund config set web_search.tavily_api_key <key>',
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
      let status
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
      const tavily = status.tavily ?? {}
      const brave = status.brave ?? {}
      const custom = status.custom ?? {}
      const maxResults = typeof status.max_results === 'number' ? status.max_results : null
      const entries = [
        {
          id: 'backend',
          label: 'backend',
          value: backend ?? 'unset',
          status: backend ? 'configured' : 'not configured',
          detail: backend
            ? `web_search.backend = "${backend}"`
            : [
                'web_search.backend is not set — WebSearch fails closed until it is.',
                'Pick a backend:',
                '',
                '  volund config set web_search.backend tavily',
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
