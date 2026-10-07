'use client'

/**
 * 源码查看器（工作台「文件」标签页）：只读态用 prism-react-renderer 做语法
 * 高亮（逐行渲染保留行号与搜索跳转；语言按扩展名映射，未命中回落纯文本），
 * 主题跟随亮/暗；「编辑」切换为纯文本 TextArea（保存 wbWriteFile）。
 * 刻意不依赖内嵌 VS Code workbench：initialize 是全局单例且会把 workbench
 * UI 挂进容器，侧栏面板抢装配会污染代码页的 DOM 归属。
 */
import { EyeOutlined, EditOutlined, DownloadOutlined } from '@ant-design/icons'
import { App, Button, Empty, Input, Spin, Tooltip, Typography } from 'antd'
import { Highlight, themes } from 'prism-react-renderer'
import { useEffect, useRef, useState } from 'react'

import type { WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { previewKindOf } from '../lib/preview-kind'
import { useThemeMode } from '../lib/theme'

/** 扩展名 → prism 语言 id（内置集合内；未命中 = 纯文本不高亮）。 */
const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  java: 'clike',
  swift: 'clike',
  kt: 'clike',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  toml: 'toml',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
}

const languageOf = (path: string): string => {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (EXT_LANGUAGE[name.slice(dot + 1).toLowerCase()] ?? '') : ''
}

export function SourcePanel({
  api,
  path,
  line,
  onOpenPreview,
}: {
  api: WebApi
  path: string
  line?: number
  onOpenPreview(path: string): void
}) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const { resolved } = useThemeMode()
  const [file, setFile] = useState<{ binary: boolean; content: string; truncated: boolean }>()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEditing(false)
    void api
      .wbReadFile(path)
      .then((result) => {
        setFile({
          binary: result.binary,
          content: result.content,
          truncated: result.truncated,
        })
        setDraft(result.content)
      })
      .catch((cause) => {
        setFile(undefined)
        message.error(cause instanceof Error ? cause.message : String(cause))
      })
  }, [api, path, message])

  // 搜索跳转：渲染后滚动到目标行（行高固定 19px 与 css 对齐）。
  useEffect(() => {
    if (!line || !file || editing) return
    const target = bodyRef.current?.querySelector(`[data-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [file, line, editing])

  if (!file) return <Spin size="small" style={{ display: 'block', margin: '24px auto' }} />
  if (file.binary)
    return (
      <div className="workbench-empty" style={{ gap: 12 }}>
        <Empty description={t('manage.binaryNotViewable')} style={{ marginTop: 24 }} />
        {previewKindOf(path) !== 'text' && (
          <Button icon={<EyeOutlined />} onClick={() => onOpenPreview(path)}>
            {t('manage.preview')}
          </Button>
        )}
        <Button
          icon={<DownloadOutlined />}
          onClick={() => {
            void api.wbRawToken().then((token) => {
              const anchor = document.createElement('a')
              anchor.href = api.wbRawUrl(path, token, true)
              anchor.download = path.split('/').pop() ?? path
              anchor.click()
            })
          }}
        >
          {t('manage.downloadFile')}
        </Button>
      </div>
    )

  const save = async () => {
    setSaving(true)
    try {
      await api.wbWriteFile(path, draft)
      setFile({ ...file, content: draft })
      setEditing(false)
      message.success(t('manage.saved'))
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const language = languageOf(path)
  const theme = resolved === 'dark' ? themes.vsDark : themes.vsLight

  return (
    <div className="wb-pane wb-file">
      <div className="wb-file-bar">
        <Typography.Text type="secondary" ellipsis style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
          {path}
          {file.truncated ? t('manage.truncatedSuffix') : ''}
        </Typography.Text>
        {previewKindOf(path) !== 'text' && !editing && (
          <Tooltip title={t('manage.preview')}>
            <Button
              size="small"
              type="text"
              icon={<EyeOutlined />}
              aria-label={t('manage.preview')}
              onClick={() => onOpenPreview(path)}
            />
          </Tooltip>
        )}
        {editing ? (
          <>
            <Button size="small" type="primary" loading={saving} onClick={() => void save()}>
              {t('manage.save')}
            </Button>
            <Button size="small" onClick={() => setEditing(false)}>
              {t('manage.cancel')}
            </Button>
          </>
        ) : (
          <Tooltip title={file.truncated ? t('manage.truncatedEditWarning') : t('manage.edit')}>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label={t('manage.edit')}
              disabled={file.truncated}
              onClick={() => setEditing(true)}
            />
          </Tooltip>
        )}
      </div>
      {editing ? (
        <Input.TextArea
          className="wb-file-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          autoSize={{ minRows: 12 }}
        />
      ) : (
        <div className="wb-file-body" ref={bodyRef}>
          <Highlight theme={theme} code={file.content} language={language || 'text'}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <>
                {tokens.map((lineTokens, index) => {
                  const { key: _lineKey, ...lineProps } = getLineProps({ line: lineTokens })
                  return (
                    <div
                      key={index}
                      data-line={index + 1}
                      {...lineProps}
                      className={
                        index + 1 === line ? 'wb-file-line wb-file-line-hit' : 'wb-file-line'
                      }
                    >
                      <span className="wb-file-lineno">{index + 1}</span>
                      <span>
                        {lineTokens.map((token, tokenIndex) => {
                          const { key: _tokenKey, ...tokenProps } = getTokenProps({ token })
                          return <span key={tokenIndex} {...tokenProps} />
                        })}
                      </span>
                    </div>
                  )
                })}
              </>
            )}
          </Highlight>
        </div>
      )}
    </div>
  )
}
