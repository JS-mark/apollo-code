'use client'

/** 我的：外观主题 / 设备信息 / 网关地址 / 凭证有效期 / 解除配对（清本地凭证）。 */
import {
  DisconnectOutlined,
  LinkOutlined,
  MoonOutlined,
  SafetyOutlined,
  SunOutlined,
} from '@ant-design/icons'
import { Button, Card, Descriptions, Popconfirm, Segmented, Space, Typography } from 'antd'

import type { MobileSession } from '../lib/gateway'
import { useThemeMode, type ThemeMode } from '../lib/theme'

/** 外观三态：自动（跟随系统）/ 白昼 / 暗夜（Segmented 单选即生效，设备级持久化）。 */
const THEME_OPTIONS: { value: ThemeMode; label: React.ReactNode }[] = [
  { value: 'system', label: '自动' },
  {
    value: 'light',
    label: (
      <Space size={4}>
        <SunOutlined /> 白昼
      </Space>
    ),
  },
  {
    value: 'dark',
    label: (
      <Space size={4}>
        <MoonOutlined /> 暗夜
      </Space>
    ),
  },
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
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
      <Card size="small" title="外观" style={{ marginBottom: 12 }}>
        <Segmented
          block
          options={THEME_OPTIONS}
          value={mode}
          onChange={(value) => setMode(value as ThemeMode)}
        />
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
                  <LinkOutlined /> 网关
                </Space>
              ),
              children: window.location.host,
            },
            {
              key: 'state',
              label: '链路',
              children: connected ? '已连接' : '重连中',
            },
            {
              key: 'session',
              label: '会话',
              children: activeSessionId ?? '无活动会话',
            },
            {
              key: 'device',
              label: (
                <Space size={4}>
                  <SafetyOutlined /> 设备
                </Space>
              ),
              children: `${session.deviceId}`,
            },
            {
              key: 'expiry',
              label: '凭证有效期至',
              children: new Date(session.expiresAt * 1000).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, padding: '0 4px' }}>
        设备凭证由网关签发（默认 30 天）；如需立即失效，请在桌面「远程控制」页撤销本设备。
      </Typography.Paragraph>
      <Popconfirm
        title="解除配对？"
        description="清除本机凭证并回到配对页（桌面端撤销可立即失效）"
        onConfirm={onUnpair}
      >
        <Button block danger icon={<DisconnectOutlined />}>
          解除配对
        </Button>
      </Popconfirm>
    </div>
  )
}
