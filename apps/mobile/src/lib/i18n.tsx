'use client'

import { interpolate, resolveLocale, type Locale } from '@volund/shared/i18n'
/**
 * mobile 端 i18n 状态源（i18n-r1）：与 theme.tsx 同款三件套——localStorage
 * 持久化（设备级）+ Provider 挂载后校正 + layout 内联脚本落 html lang 首帧值。
 * 字典为 TS 单文件（zh 权威 / en 同键），共享解析核心在 @volund/shared/i18n。
 * lib 模块（无 React）经 currentLocale() 单例取当前语言，由本 Provider 同步。
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { dictionaries, type DictKey } from './dict'

const STORAGE_KEY = 'volund-mobile-locale'

export type Translate = (key: DictKey, params?: Record<string, string | number>) => string

/** 纯翻译函数（lib 模块用）：插值 + 缺键回退 key 本身（便于漏译排查）。 */
export function translate(locale: Locale, key: DictKey, params?: Record<string, string | number>) {
  return interpolate(dictionaries[locale][key] ?? key, params)
}

// ---- lib 模块单例（无 React 上下文可用的取值面） ----

let current: Locale = 'zh'

/** lib 模块取当前语言（Provider 挂载/切换时同步）。 */
export function currentLocale(): Locale {
  return current
}

/** lib 模块语言注入（仅 Provider 与测试应调用）。 */
export function setCurrentLocale(locale: Locale): void {
  current = locale
}

// ---- React 绑定 ----

interface I18nContextValue {
  locale: Locale
  setLocale(locale: Locale): void
  t: Translate
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  setLocale: () => {},
  t: (key) => key,
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

/** 读持久化档位（resolveLocale 同口径：localStorage → navigator → zh）。 */
export function loadLocale(): Locale {
  try {
    return resolveLocale(window.localStorage.getItem(STORAGE_KEY), window.navigator.language)
  } catch {
    // 隐私模式等读不出存储时按默认 zh 处理
    return 'zh'
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // SSG 预渲染无 window：初始 zh，挂载后 useEffect 校正（与 theme 同款）。
  const [locale, setLocaleState] = useState<Locale>('zh')
  useEffect(() => {
    setLocaleState(loadLocale())
  }, [])
  useEffect(() => {
    current = locale
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 写不进存储时不持久化（本次运行内仍生效）
    }
  }, [])
  const t = useCallback<Translate>((key, params) => translate(locale, key, params), [locale])
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}
