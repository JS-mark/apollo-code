'use client'

import { AntdRegistry } from '@ant-design/nextjs-registry'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'

import { AppShell } from '../components/AppShell'
import { I18nProvider, useI18n } from '../lib/i18n'
import { ThemeModeProvider, useThemeMode } from '../lib/theme'

function Themed({ children }: { children: React.ReactNode }) {
  const { resolved } = useThemeMode()
  const { locale } = useI18n()
  return (
    <ConfigProvider
      locale={locale === 'zh' ? zhCN : enUS}
      theme={{
        // antd v6 默认开启 cssVar（--ant-* 变量随 algorithm 切换），壳层布局直接用。
        algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#2f6feb' },
      }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  )
}

export default function Page() {
  return (
    <AntdRegistry>
      <I18nProvider>
        <ThemeModeProvider>
          <Themed>
            <AppShell />
          </Themed>
        </ThemeModeProvider>
      </I18nProvider>
    </AntdRegistry>
  )
}
