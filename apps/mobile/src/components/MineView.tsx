'use client'

/** 我的：界面语言 / 外观主题 / 设备信息 / 网关地址 / 凭证有效期 / 解除配对（清本地凭证）。 */
import {
  DisconnectOutlined,
  LinkOutlined,
  MoonOutlined,
  SafetyOutlined,
  SunOutlined,
} from '@ant-design/icons'
import type { Locale } from '@volund/shared/i18n'
import { Button, Card, Descriptions, Popconfirm, Segmented, Space, Typography } from 'antd'

import type { MobileSession } from '../lib/gateway'
import { useI18n, type Translate } from '../lib/i18n'
import { useThemeMode, type ThemeMode } from '../lib/theme'

/** 外观三态：自动（跟随系统）/ 白昼 / 暗夜（Segmented 单选即生效，设备级持久化）。 */
const themeOptions = (t: Translate): { value: ThemeMode; label: React.ReactNode }[] => [
  { value: 'system', label: t('mine.themeAuto') },
  {
    value: 'light',
    label: (
      <Space size={4}>
        <SunOutlined /> {t('mine.themeLight')}
      </Space>
    ),
  },
  {
    value: 'dark',
    label: (
      <Space size={4}>
        <MoonOutlined /> {t('mine.themeDark')}
      </Space>
    ),
  },
]

/** 语言二态：中文 / English（同款 Segmented 交互，持久化在设备 localStorage）。 */
const languageOptions = (t: Translate): { value: Locale; label: string }[] => [
  { value: 'zh', label: t('common.languageZh') },
  { value: 'en', label: t('common.languageEn') },
]

export function MineView({
  session,
  connected,
  activeSessionId,
  onUnpair,
}: {
  session: MobileSession
  connected: boolean
  activeSessionId: string | undefined
  onUnpair(): void
}) {
  const { mode, setMode } = useThemeMode()
  const { locale, setLocale, t } = useI18n()
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
      <Card size="small" title={t('mine.appearance')} style={{ marginBottom: 12 }}>
        <Segmented
          block
          options={themeOptions(t)}
          value={mode}
          onChange={(value) => setMode(value as ThemeMode)}
        />
      </Card>
      <Card size="small" title={t('common.language')} style={{ marginBottom: 12 }}>
        <Segmented block options={languageOptions(t)} value={locale} onChange={setLocale} />
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
          {t('common.languageHint')}
        </Typography.Text>
      </Card>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Descriptions
          column={1}
          size="small"
          items={[
            {
              key: 'gateway',
              label: (
                <Space size={4}>
                  <LinkOutlined /> {t('mine.gateway')}
                </Space>
              ),
              children: window.location.host,
            },
            {
              key: 'state',
              label: t('mine.link'),
              children: connected ? t('mine.connected') : t('mine.reconnecting'),
            },
            {
              key: 'session',
              label: t('mine.session'),
              children: activeSessionId ?? t('mine.noActiveSession'),
            },
            {
              key: 'device',
              label: (
                <Space size={4}>
                  <SafetyOutlined /> {t('mine.device')}
                </Space>
              ),
              children: `${session.deviceId}`,
            },
            {
              key: 'expiry',
              label: t('mine.credentialExpiry'),
              children: new Date(session.expiresAt * 1000).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, padding: '0 4px' }}>
        {t('mine.credentialHint')}
      </Typography.Paragraph>
      <Popconfirm
        title={t('mine.unpairTitle')}
        description={t('mine.unpairDescription')}
        onConfirm={onUnpair}
      >
        <Button block danger icon={<DisconnectOutlined />}>
          {t('mine.unpair')}
        </Button>
      </Popconfirm>
    </div>
  )
}
