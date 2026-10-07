/**
 * [web_search] 配置段读取与 WebSearch provider 适配（volund-plugin-web-search）：
 * 插件经 webSearch.provide 贡献搜索后端，宿主每次搜索重读用户级 config.toml
 * （[env] 生效快照同款「每次调用重读」语义）注入给插件——改配置即时生效，
 * api key 不落插件沙箱之外的数据结构（只随单次调用过桥）。
 */
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'
import { VolundError } from '@volund/shared'
import type { JsonValue } from '@volund/shared'
import type { WebSearchProvider, WebSearchProviderResult } from '@volund/tools'

/** [web_search] 段的形状（与 ConfigSchema 对齐；读取端再防御一次）。 */
export interface WebSearchConfig {
  backend?: 'tavily' | 'brave' | 'custom'
  max_results?: number
  tavily_api_key?: string
  brave_api_key?: string
  custom_url?: string
  custom_api_key?: string
}

/** 每次调用重读用户级 config.toml 的 [web_search] 段；缺文件/缺段 → 空对象。 */
export async function readWebSearchConfig(home: string): Promise<WebSearchConfig> {
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const section =
    config.web_search && typeof config.web_search === 'object' && !Array.isArray(config.web_search)
      ? (config.web_search as Record<string, JsonValue>)
      : {}
  const customUrl =
    typeof section.custom_url === 'string' && /^https?:\/\//.test(section.custom_url)
      ? section.custom_url
      : undefined
  return {
    ...(section.backend === 'tavily' || section.backend === 'brave' || section.backend === 'custom'
      ? { backend: section.backend }
      : {}),
    ...(typeof section.max_results === 'number' ? { max_results: section.max_results } : {}),
    ...(typeof section.tavily_api_key === 'string' && section.tavily_api_key
      ? { tavily_api_key: section.tavily_api_key }
      : {}),
    ...(typeof section.brave_api_key === 'string' && section.brave_api_key
      ? { brave_api_key: section.brave_api_key }
      : {}),
    ...(customUrl !== undefined ? { custom_url: customUrl } : {}),
    ...(typeof section.custom_api_key === 'string' && section.custom_api_key
      ? { custom_api_key: section.custom_api_key }
      : {}),
  }
}

/**
 * `/web-search` 面板的配置 presence：api key 只过布尔；custom_url 非凭据可回显。
 * 供 webSearch.configStatus 桥方法返回。
 */
export function webSearchConfigStatus(config: WebSearchConfig): Record<string, unknown> {
  return {
    backend: config.backend ?? null,
    max_results: config.max_results ?? null,
    tavily: { configured: Boolean(config.tavily_api_key) },
    brave: { configured: Boolean(config.brave_api_key) },
    custom: {
      url: config.custom_url ?? null,
      apiKeyConfigured: Boolean(config.custom_api_key),
    },
  }
}

/**
 * http.fetch 的动态 net 放行名单：[web_search] custom_url 的主机名（backend=custom
 * 的搜索端点不在插件 manifest allowlist 里，用户级 config 亲自配置即视为授权）。
 * 每次调用重取，随配置即时生效。
 */
export async function webSearchExtraAllowedHosts(home: string): Promise<readonly string[]> {
  const config = await readWebSearchConfig(home)
  if (!config.custom_url) return []
  try {
    return [new URL(config.custom_url).hostname]
  } catch {
    return []
  }
}

/**
 * 把插件的 provider 贡献适配成内置 WebSearch 工具消费的 WebSearchProvider：
 * search 前重读 [web_search]，backend 未设置时默认注入 tavily（与设置页下拉
 * 「默认选中 tavily」同口径；缺对应 key 仍 fail-closed，指引信息进工具错误）；
 * 返回值逐项校验形状，坏数据 fail-closed 而不是透传给模型。
 */
export function pluginWebSearchProvider(input: {
  plugin: string
  id: string
  invoke(request: unknown, config: unknown): Promise<unknown>
  readConfig: () => Promise<WebSearchConfig>
}): WebSearchProvider {
  return {
    id: `${input.plugin}/${input.id}`,
    async search(request, context) {
      const config = await input.readConfig()
      const effective = { ...config, backend: config.backend ?? 'tavily' }
      const raw = (await input.invoke(
        { query: request.query, limit: request.limit },
        effective,
      )) as unknown
      if (!Array.isArray(raw))
        throw new VolundError(
          'plugin_web_search_invalid',
          `web search provider '${input.plugin}' returned a non-array response`,
        )
      const items: WebSearchProviderResult[] = []
      for (const entry of raw) {
        const item = entry as Partial<WebSearchProviderResult> | null | undefined
        if (
          !item ||
          typeof item.title !== 'string' ||
          typeof item.url !== 'string' ||
          typeof item.snippet !== 'string'
        )
          throw new VolundError(
            'plugin_web_search_invalid',
            `web search provider '${input.plugin}' returned a malformed result item`,
          )
        const normalized: WebSearchProviderResult = {
          title: item.title,
          url: item.url,
          snippet: item.snippet,
        }
        if (typeof item.publishedAt === 'string') normalized.publishedAt = item.publishedAt
        items.push(normalized)
      }
      if (context.signal.aborted)
        throw new VolundError('plugin_web_search_aborted', 'Web search aborted')
      return items
    },
  }
}
