'use client'

/**
 * 产物预览面板（工作台「预览」标签页）：按 previewKindOf 分派——
 * - 图片：raw 直出 URL 直挂 `<img>`（不经 base64，>2MiB 也不受限），antd Image
 *   自带点击放大/旋转；
 * - HTML 产物：sandbox iframe（刻意不含 allow-same-origin → 产物跑在 opaque
 *   origin，摸不到会话 cookie/CSRF/localStorage），配合服务端为该路由发出的
 *   产物 CSP（connect-src 'none'）双层隔离；子资源不带 cookie，URL 里带
 *   raw-token（opaque origin 的必然后果，见 api.wbRawToken）；
 * - PDF：同源 iframe 交给浏览器内置查看器（不加 sandbox——内置查看器自身隔离，
 *   加了反而不渲染）；
 * - Markdown：文本读取后复用聊天渲染器，相对图片地址重写到 raw 直出
 *   （外部 http(s) 图片维持 W-04 占位降级）。
 * 顶栏是浏览器式地址栏：路径可点击进入编辑态，回车按扩展名智能跳转（源码或
 * 预览）；按钮组最右，含「打开源码」。
 */
import {
  CodeOutlined,
  DownloadOutlined,
  ExportOutlined,
  FileOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { App, Button, Image, Input, Spin, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'
import type { PreviewKind } from '../lib/preview-kind'
import { Markdown } from './Markdown'

/** 沙箱权限：只放脚本与弹窗确认（alert/confirm），不给同源不给表单不给顶层导航。 */
const HTML_SANDBOX = 'allow-scripts allow-modals'

export function FilePreview({
  api,
  path,
  kind,
  onOpenSource,
  onOpenPath,
}: {
  api: WebApi
  path: string
  kind: Exclude<PreviewKind, 'text'>
  /** 地址栏「打开源码」：切到/打开该文件的源码标签页。 */
  onOpenSource(path: string): void
  /** 地址栏回车跳转：按扩展名智能落到源码或预览标签页。 */
  onOpenPath(path: string): void
}) {
  const { message } = App.useApp()
  const [nonce, setNonce] = useState(0)
  // raw-token：所有直出 URL 的公共前缀（opaque iframe 子资源无 cookie，见上）。
  const [token, setToken] = useState<string>()
  // Markdown 分支的文本内容（其余分支零状态，直接由 URL 驱动）。
  const [md, setMd] = useState<{ content: string; truncated: boolean }>()
  // 地址栏编辑态（浏览器地址栏：点路径 → 输入 → 回车跳转 / Esc·失焦还原）。
  const [editingAddr, setEditingAddr] = useState(false)
  const [addrDraft, setAddrDraft] = useState(path)

  useEffect(() => {
    setMd(undefined)
    setEditingAddr(false)
    setNonce((value) => value + 1)
  }, [path])

  useEffect(() => {
    void api
      .wbRawToken()
      .then(setToken)
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }, [api, message])

  useEffect(() => {
    if (kind !== 'markdown') return
    void api
      .wbReadFile(path)
      .then((result) => setMd({ content: result.content, truncated: result.truncated }))
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }, [api, path, kind, message])

  const reload = () => setNonce((value) => value + 1)
  const openExternal = () => {
    if (!token) return
    void api
      .wbRawToken()
      .then((fresh) => window.open(api.wbRawUrl(path, fresh), '_blank', 'noopener'))
  }
  const download = () => {
    if (!token) return
    void api.wbRawToken().then((fresh) => {
      const anchor = document.createElement('a')
      anchor.href = api.wbRawUrl(path, fresh, true)
      anchor.download = path.split('/').pop() ?? path
      anchor.click()
    })
  }

  const commitAddr = () => {
    const next = addrDraft.trim()
    setEditingAddr(false)
    if (!next || next === path) return
    void api
      .wbStat(next)
      .then((stat) => {
        if (stat.kind === 'dir') {
          message.warning('这是目录——请在资源管理器中浏览')
          return
        }
        onOpenPath(next)
      })
      .catch((cause) => message.error(cause instanceof Error ? cause.message : String(cause)))
  }

  // Markdown 相对图片 → raw 直出（../ ./ 归一化后仍由服务端逃逸门兜底）。
  const resolveMdImage = (src: string): string | undefined => {
    if (!token) return undefined
    if (src.startsWith('data:')) return src
    if (/^(https?:)?\/\//i.test(src) || /^(https?:)/i.test(src)) return undefined
    const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    const segments: string[] = []
    for (const segment of `${base}${src}`.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') segments.pop()
      else segments.push(segment)
    }
    return api.wbRawUrl(segments.join('/'), token)
  }

  if (!token) return <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
  const rawUrl = api.wbRawUrl(path, token)

  return (
    <div className="wb-preview">
      <div className="wb-file-bar">
        {editingAddr ? (
          <Input
            size="small"
            autoFocus
            prefix={<FileOutlined />}
            value={addrDraft}
            onChange={(event) => setAddrDraft(event.target.value)}
            onPressEnter={commitAddr}
            onFocus={(event) => event.target.select()}
            onBlur={commitAddr}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditingAddr(false)
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
        ) : (
          <Tooltip title="点击编辑路径，回车跳转（同浏览器地址栏）">
            <Typography.Text
              type="secondary"
              ellipsis
              className="wb-addr"
              style={{ flex: 1, minWidth: 0, fontSize: 12 }}
              onClick={() => {
                setAddrDraft(path)
                setEditingAddr(true)
              }}
            >
              {path}
            </Typography.Text>
          </Tooltip>
        )}
        {kind === 'html' && <Tag style={{ marginRight: 0 }}>沙箱</Tag>}
        <Tooltip title="打开源码">
          <Button
            size="small"
            type="text"
            icon={<CodeOutlined />}
            aria-label="打开源码"
            onClick={() => onOpenSource(path)}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            aria-label="刷新预览"
            onClick={reload}
          />
        </Tooltip>
        <Tooltip title="新窗口打开">
          <Button
            size="small"
            type="text"
            icon={<ExportOutlined />}
            aria-label="在新窗口打开"
            onClick={openExternal}
          />
        </Tooltip>
        <Tooltip title="下载">
          <Button
            size="small"
            type="text"
            icon={<DownloadOutlined />}
            aria-label="下载文件"
            onClick={download}
          />
        </Tooltip>
      </div>
      {kind === 'image' ? (
        <div className="wb-preview-image" key={`img:${nonce}`}>
          <Image src={`${rawUrl}?v=${nonce}`} alt={path} style={{ maxWidth: '100%' }} />
        </div>
      ) : kind === 'html' ? (
        <iframe
          key={`html:${nonce}`}
          className="wb-preview-frame"
          src={rawUrl}
          sandbox={HTML_SANDBOX}
          referrerPolicy="no-referrer"
          title={path}
        />
      ) : kind === 'pdf' ? (
        <iframe
          key={`pdf:${nonce}`}
          className="wb-preview-frame"
          src={rawUrl}
          referrerPolicy="no-referrer"
          title={path}
        />
      ) : md === undefined ? (
        <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
      ) : (
        <div className="wb-preview-markdown">
          {md.truncated && (
            <Typography.Text type="warning" style={{ display: 'block', fontSize: 12 }}>
              文件过大，仅展示前 512 KiB
            </Typography.Text>
          )}
          <Markdown text={md.content} transformImgSrc={resolveMdImage} />
        </div>
      )}
    </div>
  )
}
