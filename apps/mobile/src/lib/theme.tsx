'use client'

/**
 * 外观主题状态源（移动站）：白昼 / 暗夜 / 自动（跟随系统 prefers-color-scheme）。
 * localStorage 持久化（设备级）；resolved 挂到 document.body.dataset.theme——
 * globals.css 的全部暗色规则以它为锚。首帧不闪由 layout.tsx 的内联脚本保证
 * （读同一份 localStorage），hydration 后本 provider 接管（含系统切色跟随）。
 */
import { createContext, useContext, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'volund-mobile-theme'

interface ThemeContextValue {
  mode: ThemeMode
  /** 实际应用的亮/暗（system 已按系统偏好解析）。 */
  resolved: 'light' | 'dark'
  setMode(mode: ThemeMode): void
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  setMode: () => {},
})

export function useThemeMode(): ThemeContextValue {
  return useContext(ThemeContext)
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 读持久化档位（非法值按 system 处理——layout 内联脚本同口径）。 */
export function loadThemeMode(): ThemeMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved
  } catch {
    // 隐私模式等读不出存储时按跟随系统处理
  }
  return 'system'
}

export function ThemeModeProvider({ children }: { children: React.ReactNode }) {
  // SSG 预渲染无 window：初始 system+light，挂载后 useEffect 校正（与 web 同款）。
  const [mode, setMode] = useState<ThemeMode>('system')
  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    setMode(loadThemeMode())
    setSystemDark(systemPrefersDark())
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  useEffect(() => {
    document.body.dataset.theme = resolved
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // 写不进存储时不持久化（本次运行内仍生效）
    }
  }, [mode, resolved])
  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  )
}
