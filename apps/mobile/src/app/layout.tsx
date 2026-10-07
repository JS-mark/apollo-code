import type { Metadata, Viewport } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Volund',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {/* 主题首帧不闪：白昼/暗夜/自动三态读 localStorage（lib/theme.tsx 同源 key），
            未设置/自动按系统偏好解析。hydration 后由 ThemeModeProvider 接管（含系统
            切色跟随），这里只落地初值、不挂常驻监听，避免与 provider 打架。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem('volund-mobile-theme');var dark=s==='dark'||(s!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.body.dataset.theme=dark?'dark':'light';var l=localStorage.getItem('volund-mobile-locale');document.documentElement.lang=l==='en'?'en':'zh-CN'}catch(e){}`,
          }}
        />
        {children}
      </body>
    </html>
  )
}
