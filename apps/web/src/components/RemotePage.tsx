'use client'

/**
 * 远程控制页（REM-r1）：渠道管理。
 * 顶部总开关（uplink 拨出状态 + 网关凭证配置）；已连渠道卡（一期只有移动端
 * 网站，微信/企微占位「即将上线」）；配对卡（二维码 + 配对码 + 有效期倒计时）；
 * 设备管理（已配对手机 / 撤销）。
 */
import {
  CheckCircleOutlined,
  DisconnectOutlined,
  LinkOutlined,
  MobileOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  List,
  Popconfirm,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import QRCode from 'qrcode'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ConfigView, PairingInvitation, RemoteView, WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { ShellKeys } from '../lib/i18n/dict/shell'

interface FieldState {
  value: string
  saving: boolean
}

function useStateField(
  initial = '',
): [FieldState, (value: string) => void, () => void, () => void] {
  const [state, setState] = useState<FieldState>({ value: initial, saving: false })
  const setValue = useCallback(
    (value: string) => setState((current) => ({ ...current, value })),
    [],
  )
  const beginSave = useCallback(() => setState((current) => ({ ...current, saving: true })), [])
  const endSave = useCallback(() => setState((current) => ({ ...current, saving: false })), [])
  return [state, setValue, beginSave, endSave]
}

const STATE_TEXT: Record<
  RemoteView['status']['state'],
  { labelKey: ShellKeys; status: 'success' | 'processing' | 'default' | 'error' }
> = {
  online: { labelKey: 'shell.remoteStateOnline', status: 'success' },
  connecting: { labelKey: 'shell.remoteStateConnecting', status: 'processing' },
  off: { labelKey: 'shell.remoteStateOff', status: 'default' },
}

export function RemotePage({ api }: { api: WebApi }) {
  const { t } = useI18n()
  const [view, setView] = useState<RemoteView>()
  const [config, setConfig] = useState<ConfigView>()
  const [pairing, setPairing] = useState<PairingInvitation>()
  const [pairingQr, setPairingQr] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [actionBusy, setActionBusy] = useState(false)
  const [gatewayUrl, setGatewayUrl, saveGatewayUrl, endSaveGatewayUrl] = useStateField()
  const [clientId, setClientId, saveClientId, endSaveClientId] = useStateField()
  const [clientSecret, setClientSecret, saveClientSecret, endSaveClientSecret] = useStateField()
  const [messageApi, contextHolder] = message.useMessage()
  const fieldsInitialized = useRef(false)

  const refresh = useCallback(async () => {
    const [remoteView, configView] = await Promise.all([
      api.remote().catch(() => undefined),
      api.configGet().catch(() => undefined),
    ])
    if (remoteView) setView(remoteView)
    if (configView) {
      setConfig(configView)
      // 凭证字段只在首帧回填一次：3s 轮询若持续回填，用户清空输入框会被旧值顶回去。
      if (!fieldsInitialized.current) {
        fieldsInitialized.current = true
        const remote = configView.config.remote as
          | { gateway_url?: string; client_id?: string }
          | undefined
        setGatewayUrl(remote?.gateway_url ?? '')
        setClientId(remote?.client_id ?? '')
      }
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      void refresh()
      setNow(Date.now())
    }, 3_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!pairing) return
    void QRCode.toDataURL(pairing.url, { width: 240, margin: 1 }).then(setPairingQr)
  }, [pairing])

  const runAction = useCallback(
    async (body: Parameters<WebApi['remoteAction']>[0]) => {
      setActionBusy(true)
      try {
        return await api.remoteAction(body)
      } catch (cause) {
        messageApi.error(cause instanceof Error ? cause.message : String(cause))
        return undefined
      } finally {
        setActionBusy(false)
      }
    },
    [api, messageApi],
  )

  const remoteConfig = config?.config.remote as
    | {
        enabled?: boolean
        gateway_url?: string
        client_id?: string
        client_secret?: boolean | string
      }
    | undefined
  const secretSet =
    remoteConfig?.client_secret === true || typeof remoteConfig?.client_secret === 'string'
  const status = view?.status
  const stateMeta = STATE_TEXT[status?.state ?? 'off']

  const toggle = useCallback(
    async (enabled: boolean) => {
      await runAction({ type: enabled ? 'start' : 'stop' })
      await refresh()
    },
    [runAction, refresh],
  )

  const saveField = useCallback(
    async (
      key: 'gateway_url' | 'client_id' | 'client_secret',
      value: string,
      begin: () => void,
      end: () => void,
    ) => {
      const trimmed = value.trim()
      if (!trimmed) {
        messageApi.warning(t('shell.remoteEmptyInput'))
        return
      }
      // schema 门（remote.client_secret min 16）前端预检：后端报 config_invalid
      // 堆栈话术，这里直接给可操作的提示。
      if (key === 'client_secret' && trimmed.length < 16) {
        messageApi.error(t('shell.remoteSecretTooShort'))
        return
      }
      begin()
      try {
        await api.configSet(`remote.${key}`, trimmed)
        messageApi.success(t('shell.remoteSaved'))
        await refresh()
        if (key === 'client_secret') setClientSecret('')
      } catch (cause) {
        messageApi.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        end()
      }
    },
    [api, messageApi, refresh, setClientSecret, t],
  )

  const generatePairing = useCallback(async () => {
    const result = (await runAction({ type: 'create-pairing' })) as
      | { pairing: PairingInvitation }
      | undefined
    if (result?.pairing) setPairing(result.pairing)
    // 失败多半是按钮可用态滞后于链路真实状态（3s 轮询窗）——立刻刷新收口。
    else await refresh()
  }, [runAction, refresh])

  const revoke = useCallback(
    async (deviceId: string) => {
      // revoked=false（链路离线/设备已不在注册表）不能静默——用户会误以为已断开。
      const result = (await runAction({ type: 'revoke-device', deviceId })) as
        | { revoked: boolean }
        | undefined
      if (result && result.revoked === false) messageApi.warning(t('shell.remoteRevokeFailed'))
      else messageApi.success(t('shell.remoteDeviceRevoked'))
      await refresh()
    },
    [runAction, refresh, messageApi, t],
  )

  const pairingSecondsLeft = useMemo(
    () => (pairing ? Math.max(0, Math.floor((pairing.expiresAt - now) / 1000)) : 0),
    [pairing, now],
  )

  const availableChannels = view?.channels.filter((channel) => channel.available) ?? []
  const comingSoonChannels = view?.channels.filter((channel) => !channel.available) ?? []

  return (
    <section className="page" style={{ padding: 24, overflow: 'auto', maxWidth: 880 }}>
      {contextHolder}
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {t('shell.remoteTitle')}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
        {t('shell.remoteSubtitle')}
      </Typography.Paragraph>

      {/* 总开关 + 网关配置 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space align="center" style={{ marginBottom: 16 }}>
          {status?.state === 'online' || status?.state === 'connecting' ? (
            <Button
              danger
              icon={<StopOutlined />}
              loading={actionBusy}
              onClick={() => void toggle(false)}
            >
              {t('shell.remoteStop')}
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<LinkOutlined />}
              loading={actionBusy}
              onClick={() => void toggle(true)}
            >
              {t('shell.remoteStart')}
            </Button>
          )}
          <Badge status={stateMeta.status} text={t(stateMeta.labelKey)} />
          {status?.gatewayUrl && (
            <Typography.Text type="secondary">{status.gatewayUrl}</Typography.Text>
          )}
        </Space>
        {/* 连接中/失败的原因显眼展示——配对等操作依赖在线状态，藏小字会被当成按钮 bug。 */}
        {status?.state === 'connecting' && status.lastError && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('shell.remoteRetrying', { attempt: status.attempt, error: status.lastError })}
            description={t('shell.remoteRetryHint')}
          />
        )}
        <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
          <Space.Compact style={{ display: 'flex' }}>
            <Input
              prefix={<LinkOutlined />}
              placeholder={t('shell.remoteGatewayPlaceholder')}
              value={gatewayUrl.value}
              onChange={(event) => setGatewayUrl(event.target.value)}
            />
            <Button
              loading={gatewayUrl.saving}
              onClick={() =>
                void saveField('gateway_url', gatewayUrl.value, saveGatewayUrl, endSaveGatewayUrl)
              }
            >
              {t('shell.save')}
            </Button>
          </Space.Compact>
          <Space.Compact style={{ display: 'flex' }}>
            <Input
              placeholder={t('shell.remoteClientIdPlaceholder')}
              value={clientId.value}
              onChange={(event) => setClientId(event.target.value)}
            />
            <Button
              loading={clientId.saving}
              onClick={() =>
                void saveField('client_id', clientId.value, saveClientId, endSaveClientId)
              }
            >
              {t('shell.save')}
            </Button>
          </Space.Compact>
          <Space.Compact style={{ display: 'flex' }}>
            <Input.Password
              placeholder={
                secretSet
                  ? t('shell.remoteSecretSetPlaceholder')
                  : t('shell.remoteSecretPlaceholder')
              }
              value={clientSecret.value}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            <Button
              loading={clientSecret.saving}
              onClick={() =>
                void saveField(
                  'client_secret',
                  clientSecret.value,
                  saveClientSecret,
                  endSaveClientSecret,
                )
              }
            >
              {t('shell.save')}
            </Button>
          </Space.Compact>
        </Space>
      </Card>

      {/* 已连渠道 */}
      <Card
        size="small"
        title={t('shell.remoteChannelsTitle')}
        style={{ marginBottom: 16 }}
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>
            {t('shell.refresh')}
          </Button>
        }
      >
        {availableChannels.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('shell.remoteChannelsEmpty')}
          />
        ) : (
          <List
            dataSource={availableChannels}
            renderItem={(channel) => (
              <List.Item
                actions={
                  channel.id === 'mobile-web'
                    ? [
                        <Badge
                          key="state"
                          status={status?.state === 'online' ? 'success' : 'default'}
                          text={status?.state === 'online' ? t('shell.online') : t('shell.offline')}
                        />,
                        <Tag key="devices">
                          {t('shell.remoteDeviceCount', { count: view?.devices.length ?? 0 })}
                        </Tag>,
                      ]
                    : []
                }
              >
                <List.Item.Meta
                  avatar={<MobileOutlined style={{ fontSize: 20 }} />}
                  title={channel.name}
                  description={channel.description}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 配对（仅移动站渠道 + 在线时可用） */}
      <Card
        size="small"
        title={t('shell.remotePairingTitle')}
        style={{ marginBottom: 16 }}
        extra={
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlusOutlined />}
            disabled={status?.state !== 'online'}
            onClick={() => void generatePairing()}
          >
            {t('shell.remoteGeneratePairing')}
          </Button>
        }
      >
        {status?.state !== 'online' ? (
          <Typography.Text type="secondary">{t('shell.remotePairingOfflineHint')}</Typography.Text>
        ) : pairing && pairingSecondsLeft > 0 ? (
          <Space size={24} align="start">
            {pairingQr && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pairingQr} alt={t('shell.remotePairingQrAlt')} width={180} height={180} />
            )}
            <Space orientation="vertical" size={4}>
              <Typography.Text
                copyable={{ text: pairing.url }}
                style={{ fontSize: 20, letterSpacing: 4 }}
              >
                {pairing.code}
              </Typography.Text>
              <Typography.Text type="secondary">{t('shell.remotePairingScanHint')}</Typography.Text>
              <Typography.Text type="secondary">
                {t('shell.remotePairingExpires', { seconds: pairingSecondsLeft })}
              </Typography.Text>
            </Space>
          </Space>
        ) : (
          <Typography.Text type="secondary">{t('shell.remotePairingReadyHint')}</Typography.Text>
        )}
      </Card>

      {/* 设备管理 */}
      <Card size="small" title={t('shell.remoteDevicesTitle')} style={{ marginBottom: 16 }}>
        {!view || view.devices.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('shell.remoteDevicesEmpty')} />
        ) : (
          <List
            dataSource={view.devices}
            renderItem={(device) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="revoke"
                    title={t('shell.remoteRevokeConfirmTitle')}
                    description={t('shell.remoteRevokeConfirmDesc')}
                    onConfirm={() => void revoke(device.id)}
                  >
                    <Button size="small" danger icon={<StopOutlined />}>
                      {t('shell.remoteRevoke')}
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <CheckCircleOutlined
                      style={{
                        fontSize: 16,
                        color: now - device.lastSeen < 300_000 ? undefined : undefined,
                      }}
                    />
                  }
                  title={device.name}
                  description={t('shell.remoteDeviceMeta', {
                    paired: new Date(device.pairedAt).toLocaleString(),
                    lastSeen: new Date(device.lastSeen).toLocaleString(),
                  })}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 更多渠道（R3 插件市场） */}
      <Card size="small" title={t('shell.remoteMoreChannelsTitle')}>
        <Space orientation="vertical" size={4}>
          {comingSoonChannels.map((channel) => (
            <Typography.Text key={channel.id} type="secondary">
              <DisconnectOutlined style={{ marginRight: 6 }} />
              {t('shell.remoteComingSoonChannel', {
                name: channel.name,
                description: channel.description,
              })}
            </Typography.Text>
          ))}
          <Typography.Text type="secondary">{t('shell.remoteMarketHint')}</Typography.Text>
        </Space>
      </Card>
    </section>
  )
}
