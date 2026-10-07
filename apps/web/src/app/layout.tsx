import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Volund Web',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首帧前落地主题避免闪烁（system 走 prefers-color-scheme）；顺带按持久化
        locale 校正 html lang（正文文案挂载后由 I18nProvider 接管，两段式同 theme）。
        CSP nonce 由 web-server 发 HTML 时注入。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem('volund-web-theme');document.documentElement.dataset.theme=s==='dark'||s==='light'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var l=localStorage.getItem('volund-web-locale');document.documentElement.lang=l==='en'?'en':'zh-CN'}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
