'use client'

import { interpolate, resolveLocale, type Locale } from '@volund/shared/i18n'
/**
 * web 端 i18n 状态源：轻量字典方案（i18n-r1，沿用 market 模式）——
 * React Context + TS 字典（zh 权威 / en 同键）+ localStorage 持久化 +
 * navigator.language fallback。不引入 i18next/next-intl（静态导出单页，
 * 路由级方案不可用）。字典按命名空间拆在 ./dict/*，条目 key 以
 * `<ns>.<语义名>` 命名，命名空间间禁止重名（拼合时后者会静默覆盖前者）。
 *
 * 首帧不闪由 layout.tsx 的内联脚本保证 html lang；正文文案 SSG 期按默认
 * zh 渲染、挂载后校正（与 theme 同款两段式）。lib 模块（无 React）经
 * currentLocale() 单例取当前语言，由本 Provider 同步。
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { chatEn, chatZh } from './dict/chat'
import { commonEn, commonZh } from './dict/common'
import { manageEn, manageZh } from './dict/manage'
import { settingsEn, settingsZh } from './dict/settings'
import { shellEn, shellZh } from './dict/shell'

const STORAGE_KEY = 'volund-web-locale'

// 命名空间字典在此拼合；新增命名空间 = 在 ./dict/ 建文件并在此展开。
const zh = { ...commonZh, ...settingsZh, ...manageZh, ...chatZh, ...shellZh }
const en: Record<keyof typeof zh, string> = {
  ...commonEn,
  ...settingsEn,
  ...manageEn,
  ...chatEn,
  ...shellEn,
}

export type DictKey = keyof typeof zh

/** 端内全量词典（locale → key → 文案）。 */
export const dictionaries: Record<Locale, Record<DictKey, string>> = { zh, en }

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
