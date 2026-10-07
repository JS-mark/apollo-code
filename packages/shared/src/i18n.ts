/**
 * i18n 核心（端无关）：Locale 类型、双语条目、插值与 locale 解析。
 * 只放纯函数与类型，不依赖 React——React 侧的 Provider/useI18n 由各端
 * （apps/web、apps/mobile、apps/market）自持；TUI 英文单语，只消费 ui-copy。
 *
 * 字典组织沿用 apps/market 的自研模式：zh 为权威键集合，en 类型强制同键；
 * 不引入 i18next/next-intl（web 静态导出单页，路由级方案不可行，见 i18n-r1）。
 */

export type Locale = 'zh' | 'en'

/** 一条跨端双语文案：zh 中文权威、en 英文对照（TUI 恒取 en）。 */
export interface Bilingual {
  en: string
  zh: string
}

/** 双语条目取值。 */
export function pick(copy: Bilingual, locale: Locale): string {
  return copy[locale]
}

/**
 * 极简插值：`{name}` 占位符替换，未知占位符原样保留（便于漏传参数时排查）。
 * 数字直接 String 化——web/mobile 无复数需求（中英皆可读），不做 ICU。
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    key in params ? String(params[key]) : token,
  )
}

/**
 * locale 解析（三端同口径，与 market 现行为一致）：
 * 持久化档位优先；未持久化时跟随 navigator.language（zh 前缀 → zh，否则 en）。
 */
export function resolveLocale(
  saved: string | null | undefined,
  navigatorLanguage?: string,
): Locale {
  if (saved === 'zh' || saved === 'en') return saved
  const language = (navigatorLanguage ?? '').toLowerCase()
  return language.startsWith('zh') ? 'zh' : 'en'
}
