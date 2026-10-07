/**
 * Markdown 渲染（§22 W-04）：react-markdown 默认不渲染原始 HTML（无脚本面）；
 * 远程/本地图片一律降级为文本占位（禁止自动加载外部资源）；链接强制新窗口 noopener。
 * transformImgSrc（工作台 Markdown 预览用）：返回字符串即按该地址加载图片
 * （相对路径重写到产物直出 URL），返回 undefined 保持占位降级。
 */
import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { Button, Tooltip, Typography } from 'antd'
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { useI18n } from '../lib/i18n'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const { t } = useI18n()
  return (
    <Tooltip title={copied ? t('chat.copied') : t('chat.copy')}>
      <Button
        size="small"
        type="text"
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        aria-label={copied ? t('chat.copied') : t('chat.copy')}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      />
    </Tooltip>
  )
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        borderRadius: 10,
        overflow: 'hidden',
        margin: '10px 0',
        background: 'var(--ant-color-bg-container, #fff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '2px 10px',
          fontSize: 12,
          background: 'var(--ant-color-fill-quaternary, rgba(0, 0, 0, 0.02))',
          borderBottom: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        }}
      >
        <Typography.Text type="secondary">{language}</Typography.Text>
        <CopyButton text={text} />
      </div>
      <pre
        style={{
          padding: '10px 12px',
          overflow: 'auto',
          fontSize: 12.5,
          lineHeight: 1.55,
        }}
      >
        <code>{text}</code>
      </pre>
    </div>
  )
}

export function Markdown({
  text,
  transformImgSrc,
}: {
  text: string
  transformImgSrc?: (src: string) => string | undefined
}) {
  const { t } = useI18n()
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 块级代码走 pre 覆写（fenced 块即使无语言/单行也保持代码块形态）；
          // code 只渲染行内片段。
          pre: ({ children }) => {
            const code = children as React.ReactElement<{
              className?: string
              children?: React.ReactNode
            }>
            const raw = String(code?.props?.children ?? '').replace(/\n$/, '')
            const language = /language-(\w+)/.exec(code?.props?.className ?? '')?.[1] ?? 'text'
            return <CodeBlock language={language} text={raw} />
          },
          code: ({ children }) => <Typography.Text code>{children}</Typography.Text>,
          // 远程图片不自动加载（W-04）：默认渲染为占位文本；调用方给了
          // transformImgSrc 且解析出地址（本地相对路径/data URI）才真加载。
          img: ({ alt, src }) => {
            const resolved =
              transformImgSrc && typeof src === 'string' ? transformImgSrc(src) : undefined
            if (!resolved)
              return (
                <Typography.Text type="secondary">
                  {t('chat.imagePlaceholder', { alt: alt ?? t('chat.imageUnnamed') })}
                </Typography.Text>
              )
            return (
              <img src={resolved} alt={alt ?? ''} loading="lazy" style={{ maxWidth: '100%' }} />
            )
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
