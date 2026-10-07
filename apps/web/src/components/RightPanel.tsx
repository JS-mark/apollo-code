'use client'

import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { Button, Descriptions, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { Bootstrap, WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** 右侧栏（连接/会话信息，真实数据源；不含伪终端）。 */
export function RightPanel({
  api,
  bootstrap,
  sessionId,
  sessionTitle,
  connected,
  onClose,
}: {
  api: WebApi
  bootstrap: Bootstrap
  sessionId: string | undefined
  sessionTitle: string | undefined
  connected: boolean
  onClose(): void
}) {
  const { t } = useI18n()
  const [permissionMode, setPermissionMode] = useState<string>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (bootstrap.capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => setPermissionMode(result.mode))
        .catch(() => {})
  }, [api, bootstrap.capabilities.permissionMode])

  const url = window.location.origin
  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: '1px solid var(--ant-color-border-secondary, #e2e6ec)',
        padding: 16,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text strong>{t('shell.connection')}</Typography.Text>
        <Button size="small" type="text" onClick={onClose}>
          {t('shell.collapse')}
        </Button>
      </div>
      <Descriptions
        size="small"
        column={1}
        style={{ marginTop: 12 }}
        items={[
          {
            key: 'status',
            label: t('shell.status'),
            children: connected ? (
              <Tag color="success">{t('shell.remoteStateOnline')}</Tag>
            ) : (
              <Tag>{t('shell.remoteStateConnecting')}</Tag>
            ),
          },
          { key: 'version', label: t('shell.version'), children: `v${bootstrap.server.version}` },
          {
            key: 'url',
            label: t('shell.address'),
            children: (
              <>
                <Typography.Text code style={{ fontSize: 11 }}>
                  {url}
                </Typography.Text>
                <Tooltip title={copied ? t('shell.copied') : t('shell.copy')}>
                  <Button
                    size="small"
                    type="text"
                    icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                    aria-label={copied ? t('shell.copied') : t('shell.copy')}
                    onClick={() => {
                      void navigator.clipboard.writeText(url).then(() => {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1500)
                      })
                    }}
                  />
                </Tooltip>
              </>
            ),
          },
          {
            key: 'cwd',
            label: t('shell.workspace'),
            children: (
              <Typography.Text style={{ fontSize: 12, wordBreak: 'break-all' }}>
                {bootstrap.workspace.cwd}
              </Typography.Text>
            ),
          },
          {
            key: 'session',
            label: t('shell.session'),
            children: sessionTitle ?? sessionId?.slice(0, 8) ?? t('shell.notStarted'),
          },
          ...(permissionMode !== undefined
            ? [
                {
                  key: 'permission',
                  label: t('shell.permissionMode'),
                  children:
                    permissionMode === 'ask'
                      ? t('shell.permAsk')
                      : permissionMode === 'auto'
                        ? t('shell.permAuto')
                        : t('shell.permPass'),
                },
              ]
            : []),
        ]}
      />
    </aside>
  )
}
