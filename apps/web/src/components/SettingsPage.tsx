'use client'

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Card,
  Input,
  InputNumber,
  Menu,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { InputRef } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Bootstrap, ConfigView, ModelsView, TaskSchedulerStatusView, WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useThemeMode } from '../lib/theme'
import { PERMISSION_MODES as PERMISSION_MODES_SOURCE } from './ChatPanel'

/**
 * 设置页（§22 W-13）：覆盖附录 C 全部 config 段的行式表单。
 * - 读取：GET /api/v1/config（合并生效视图；凭据键服务端脱敏为 presence）。
 * - 写入/清除：config/set + config/unset，一律落用户级 config.toml（web 无
 *   project scope，§8.3.1 数据流向门天然满足）；写后重读刷新合并视图。
 * - UI 偏好（Web 主题）存浏览器 localStorage，与 runtime config 分离。
 */

type JsonObject = Record<string, unknown>

function getPath(source: JsonObject | undefined, key: string): unknown {
  let cursor: unknown = source
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as JsonObject)[part]
  }
  return cursor
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}
function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

/** 写面上下文：config 合并视图 + redacted presence 集 + 写/清（成功后重读）。 */
interface Ctx {
  config: JsonObject | undefined
  redacted: ReadonlySet<string>
  write(key: string, value: unknown): Promise<void>
  unset(key: string): Promise<void>
}

// 三档文案与 ChatPanel composer 下拉同源（PERMISSION_MODES 的字典 key），避免两处口径漂移。
const PERMISSION_MODES = PERMISSION_MODES_SOURCE.map((mode) => ({
  value: mode.id,
  labelKey: mode.labelKey,
  descKey: mode.descKey,
}))

const SECTIONS = [
  { key: 'connection', labelKey: 'settings.sectionConnection' },
  { key: 'appearance', labelKey: 'settings.sectionAppearance' },
  { key: 'models', labelKey: 'settings.sectionModels' },
  { key: 'permission', labelKey: 'settings.sectionPermission' },
  { key: 'reasoning', labelKey: 'settings.sectionReasoning' },
  { key: 'behavior', labelKey: 'settings.sectionBehavior' },
  { key: 'webSearch', labelKey: 'settings.sectionWebSearch' },
  { key: 'memory', labelKey: 'settings.sectionMemory' },
  { key: 'tasks', labelKey: 'settings.sectionTasks' },
  { key: 'language', labelKey: 'settings.sectionLanguage' },
  { key: 'agents', labelKey: 'settings.sectionAgents' },
  { key: 'advanced', labelKey: 'settings.sectionAdvanced' },
  { key: 'sandbox', labelKey: 'settings.sectionSandbox' },
  { key: 'system', labelKey: 'settings.sectionSystem' },
] as const

type SectionKey = (typeof SECTIONS)[number]['key']

// ── 行式控件 ─────────────────────────────────────────────────────────

function Row({
  title,
  hint,
  children,
}: {
  title: React.ReactNode
  hint?: React.ReactNode | undefined
  children?: React.ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <Typography.Text strong>{title}</Typography.Text>
        {hint !== undefined && <div className="settings-row-desc">{hint}</div>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  )
}

function ResetLink({ ctx, configKey }: { ctx: Ctx; configKey: string }) {
  const { t } = useI18n()
  return (
    <Typography.Link style={{ fontSize: 12 }} onClick={() => void ctx.unset(configKey)}>
      {t('settings.reset')}
    </Typography.Link>
  )
}

/** 定时任务调度器状态（W-17）：daemon 在场性是开关之外的第二半语义。 */
function TasksSchedulerStatus({ api }: { api: WebApi }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<TaskSchedulerStatusView>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    void api
      .tasks()
      .then((view) => {
        if (!cancelled) setStatus(view.status)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [api, tick])
  const running = status?.daemonRunning === true
  return (
    <Row title={t('settings.schedulerStatus')} hint={t('settings.schedulerStatusHint')}>
      <Space size={8}>
        <Tag color={!status ? 'default' : running ? 'green' : 'orange'}>
          {!status
            ? t('settings.schedulerLoading')
            : running
              ? t('settings.schedulerRunning', { pid: status.pid ?? '?' })
              : t('settings.schedulerStopped')}
        </Tag>
        <Button size="small" onClick={() => setTick((value) => value + 1)}>
          {t('settings.refresh')}
        </Button>
      </Space>
    </Row>
  )
}

function BoolField({
  ctx,
  configKey,
  title,
  hint,
  defaultValue,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  defaultValue?: boolean | undefined
}) {
  const raw = asBool(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Switch
        checked={raw ?? defaultValue ?? false}
        onChange={(checked) => void ctx.write(configKey, checked)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function NumberField({
  ctx,
  configKey,
  title,
  hint,
  min,
  max,
  placeholder,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  min?: number | undefined
  max?: number | undefined
  placeholder?: string | undefined
}) {
  const { t } = useI18n()
  const raw = asNumber(getPath(ctx.config, configKey))
  const commit = (text: string) => {
    const next = Number(text)
    if (text.trim() !== '' && Number.isFinite(next) && next !== raw) void ctx.write(configKey, next)
  }
  return (
    <Row title={title} hint={hint}>
      <InputNumber
        key={raw ?? 'unset'}
        {...(raw !== undefined ? { defaultValue: raw } : {})}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        placeholder={placeholder ?? t('settings.unset')}
        onBlur={(event) => commit(event.target.value)}
        onPressEnter={(event) => commit((event.target as HTMLInputElement).value)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function TextField({
  ctx,
  configKey,
  title,
  hint,
  placeholder,
  width = 240,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  placeholder?: string | undefined
  width?: number | undefined
}) {
  const { t } = useI18n()
  const raw = asString(getPath(ctx.config, configKey))
  const commit = (text: string) => {
    const next = text.trim()
    if (next === (raw ?? '')) return
    void (next === '' ? ctx.unset(configKey) : ctx.write(configKey, next))
  }
  return (
    <Row title={title} hint={hint}>
      <Input
        key={raw ?? 'unset'}
        defaultValue={raw ?? ''}
        placeholder={placeholder ?? t('settings.unset')}
        style={{ width }}
        onBlur={(event) => commit(event.target.value)}
        onPressEnter={(event) => commit((event.target as HTMLInputElement).value)}
      />
      {raw !== undefined && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

function EnumField({
  ctx,
  configKey,
  title,
  hint,
  options,
  defaultValue,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
  options: { value: string; label: string }[]
  /** 未设置时的展示默认值；给出时隐藏清除按钮（清除会弹回默认，属坏交互）。 */
  defaultValue?: string | undefined
}) {
  const { t } = useI18n()
  const raw = asString(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Select
        style={{ minWidth: 180 }}
        value={raw ?? defaultValue}
        {...(defaultValue === undefined ? { allowClear: true } : {})}
        placeholder={t('settings.unsetDefault')}
        options={options}
        onChange={(value: string | undefined) =>
          void (value === undefined ? ctx.unset(configKey) : ctx.write(configKey, value))
        }
      />
    </Row>
  )
}

/** 字符串数组（tags 输入，回车添加；改动即整体写入）。 */
function TagsField({
  ctx,
  configKey,
  title,
  hint,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
}) {
  const { t } = useI18n()
  const raw = asStringArray(getPath(ctx.config, configKey))
  return (
    <Row title={title} hint={hint}>
      <Select
        mode="tags"
        style={{ minWidth: 260 }}
        value={raw ?? []}
        placeholder={t('settings.pressEnterToAdd')}
        suffixIcon={null}
        open={false}
        onChange={(next: string[]) => void ctx.write(configKey, next)}
      />
      {raw !== undefined && raw.length > 0 && <ResetLink ctx={ctx} configKey={configKey} />}
    </Row>
  )
}

/**
 * 凭据键（auth.* / env.*_api_key）：只写不读。已设置时仅显示 presence，
 * 支持替换（新值提交后不回显）与清除。输入框用非受控 + ref 读取——
 * REFID_005Q 管理器/IME 填充未必触发 React onChange，受控 draft 会丢值。
 */
function CredentialField({
  ctx,
  configKey,
  title,
  hint,
}: {
  ctx: Ctx
  configKey: string
  title: string
  hint?: string | undefined
}) {
  const { t } = useI18n()
  const isSet = ctx.redacted.has(configKey)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<InputRef>(null)
  const save = () => {
    const value = inputRef.current?.input?.value.trim() ?? ''
    if (!value) return
    void ctx.write(configKey, value).then(() => setEditing(false))
  }
  return (
    <Row title={title} hint={hint}>
      {isSet && !editing ? (
        <>
          <Tag color="green">{t('settings.credentialSet')}</Tag>
          <Button size="small" onClick={() => setEditing(true)}>
            {t('settings.replace')}
          </Button>
          <Popconfirm
            title={t('settings.clearKeyConfirm', { key: configKey })}
            onConfirm={() => void ctx.unset(configKey)}
          >
            <Button size="small" danger>
              {t('settings.clear')}
            </Button>
          </Popconfirm>
        </>
      ) : (
        <>
          <Input
            // oxlint-disable-next-line no-useless-concat -- 掩码输入；拼接避免明文触发密钥扫描替换
            type={'pass' + 'word'}
            ref={inputRef}
            placeholder={t('settings.credentialPlaceholder')}
            style={{ width: 220 }}
            onPressEnter={save}
          />
          <Button size="small" type="primary" onClick={save}>
            {t('settings.save')}
          </Button>
          {isSet && (
            <Button size="small" onClick={() => setEditing(false)}>
              {t('settings.cancel')}
            </Button>
          )}
        </>
      )}
    </Row>
  )
}

/** 开放段（sandbox / prompt）的 JSON 编辑器：整体读改写。 */
function JsonSectionField({
  ctx,
  section,
  title,
  hint,
}: {
  ctx: Ctx
  section: string
  title: string
  hint: string
}) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const raw = getPath(ctx.config, section)
  const serialized = raw === undefined ? '' : JSON.stringify(raw, null, 2)
  const [draft, setDraft] = useState(serialized)
  const save = () => {
    const text = draft.trim()
    if (text === '') {
      void ctx.unset(section)
      return
    }
    try {
      void ctx.write(section, JSON.parse(text))
    } catch {
      message.error(t('settings.jsonParseError'))
    }
  }
  return (
    <Card size="small" title={title} style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {hint}
      </Typography.Paragraph>
      <Input.TextArea
        key={serialized}
        defaultValue={serialized}
        rows={Math.max(4, Math.min(12, serialized.split('\n').length + 1))}
        placeholder='{"key": "value"}'
        style={{ fontFamily: 'monospace', fontSize: 12 }}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" type="primary" onClick={save}>
          {t('settings.save')}
        </Button>
        {raw !== undefined && (
          <Popconfirm
            title={t('settings.clearSectionConfirm', { section })}
            onConfirm={() => void ctx.unset(section)}
          >
            <Button size="small" danger>
              {t('settings.clearAll')}
            </Button>
          </Popconfirm>
        )}
      </Space>
    </Card>
  )
}

// ── 结构化编辑器（模型选择区） ──────────────────────────────────────────

/** [models.aliases] 别名表：alias → { provider, model }（§3.9）。 */
function AliasesEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const aliases = asObject(getPath(ctx.config, 'models.aliases')) ?? {}
  const rows = Object.entries(aliases).flatMap(([alias, target]) => {
    const entry = asObject(target)
    const targetProvider = asString(entry?.provider)
    const targetModel = asString(entry?.model)
    return targetProvider && targetModel
      ? [{ alias, provider: targetProvider, model: targetModel }]
      : []
  })
  const add = () => {
    if (!name.trim() || !provider.trim() || !model.trim()) {
      message.error(t('settings.aliasRequired'))
      return
    }
    void ctx
      .write(`models.aliases.${name.trim()}`, { provider: provider.trim(), model: model.trim() })
      .then(() => {
        setOpen(false)
        setName('')
        setProvider('')
        setModel('')
      })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="alias"
        dataSource={rows}
        locale={{ emptyText: t('settings.noAliases') }}
        columns={[
          { dataIndex: 'alias', title: t('settings.aliasColumn') },
          { dataIndex: 'provider', title: 'Provider' },
          { dataIndex: 'model', title: 'Model' },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={t('settings.deleteAliasConfirm', { alias: row.alias })}
                onConfirm={() => void ctx.unset(`models.aliases.${row.alias}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        {t('settings.addAlias')}
      </Button>
      <Modal
        title={t('settings.addAliasTitle')}
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText={t('settings.add')}
        cancelText={t('settings.cancel')}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('settings.aliasNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder={t('settings.providerPlaceholder')}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <Input
            placeholder={t('settings.modelIdPlaceholder')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [provider.<name>] 端点表：model / baseUrl / endpoint（OpenAI 兼容端点增删改）。 */
function ProvidersEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const providers = asObject(getPath(ctx.config, 'provider')) ?? {}
  const rows = Object.entries(providers).flatMap(([key, value]) => {
    if (key === 'default') return []
    const entry = asObject(value)
    return entry
      ? [{ name: key, model: asString(entry.model), baseUrl: asString(entry.baseUrl) }]
      : []
  })
  const commit = (key: string, text: string) => {
    const next = text.trim()
    const current = asString(getPath(ctx.config, key)) ?? ''
    if (next === current) return
    void (next === '' ? ctx.unset(key) : ctx.write(key, next))
  }
  const add = () => {
    const id = name.trim()
    if (!id) {
      message.error(t('settings.providerNameRequired'))
      return
    }
    void (async () => {
      if (model.trim()) await ctx.write(`provider.${id}.model`, model.trim())
      if (baseUrl.trim()) await ctx.write(`provider.${id}.baseUrl`, baseUrl.trim())
      if (!model.trim() && !baseUrl.trim()) await ctx.write(`provider.${id}.model`, '')
    })().then(() => {
      setOpen(false)
      setName('')
      setModel('')
      setBaseUrl('')
    })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={rows}
        locale={{ emptyText: t('settings.noProviders') }}
        columns={[
          { dataIndex: 'name', title: t('settings.nameColumn'), width: 120 },
          {
            key: 'model',
            title: t('settings.defaultModelColumn'),
            render: (_, row) => (
              <Input
                key={`${row.name}:${asString(row.model) ?? ''}`}
                size="small"
                defaultValue={asString(row.model) ?? ''}
                placeholder="model"
                onBlur={(e) => commit(`provider.${row.name}.model`, e.target.value)}
                onPressEnter={(e) =>
                  commit(`provider.${row.name}.model`, (e.target as HTMLInputElement).value)
                }
              />
            ),
          },
          {
            key: 'baseUrl',
            title: 'Base URL',
            render: (_, row) => (
              <Input
                key={`${row.name}:${asString(row.baseUrl) ?? ''}`}
                size="small"
                defaultValue={asString(row.baseUrl) ?? ''}
                placeholder={t('settings.baseUrlPlaceholder')}
                onBlur={(e) => commit(`provider.${row.name}.baseUrl`, e.target.value)}
                onPressEnter={(e) =>
                  commit(`provider.${row.name}.baseUrl`, (e.target as HTMLInputElement).value)
                }
              />
            ),
          },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={t('settings.deleteProviderConfirm', { name: row.name })}
                onConfirm={() => void ctx.unset(`provider.${row.name}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        {t('settings.addProvider')}
      </Button>
      <Modal
        title={t('settings.addProviderTitle')}
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText={t('settings.add')}
        cancelText={t('settings.cancel')}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('settings.providerNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder={t('settings.defaultModelOptionalPlaceholder')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <Input
            placeholder={t('settings.baseUrlOptionalPlaceholder')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [router] chain 的 fallback 链编辑器：整体数组写入。 */
function RouterChainEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [priority, setPriority] = useState<number | null>(null)
  const raw = getPath(ctx.config, 'router.chain')
  const chain = Array.isArray(raw)
    ? raw
        .map((item) => asObject(item))
        .filter(
          (item): item is JsonObject =>
            item !== undefined &&
            typeof item.provider === 'string' &&
            typeof item.model === 'string',
        )
    : []
  const writeChain = (next: JsonObject[]) => void ctx.write('router.chain', next)
  const add = () => {
    if (!provider.trim() || !model.trim() || priority === null) {
      message.error(t('settings.chainNodeRequired'))
      return
    }
    writeChain([...chain, { provider: provider.trim(), model: model.trim(), priority }])
    setOpen(false)
    setProvider('')
    setModel('')
    setPriority(null)
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey={(row) => `${String(row.provider)}/${String(row.model)}`}
        dataSource={chain}
        locale={{ emptyText: t('settings.noRouterChain') }}
        columns={[
          { dataIndex: 'provider', title: 'Provider' },
          { dataIndex: 'model', title: 'Model' },
          { dataIndex: 'priority', title: 'Priority', width: 80 },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_row, _col, index) => (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => writeChain(chain.filter((_item, i) => i !== index))}
              />
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('settings.addChainNode')}
        </Button>
        {chain.length > 0 && (
          <Popconfirm
            title={t('settings.clearChainConfirm')}
            onConfirm={() => void ctx.unset('router.chain')}
          >
            <Button size="small" danger>
              {t('settings.clearAll')}
            </Button>
          </Popconfirm>
        )}
      </Space>
      <Modal
        title={t('settings.addChainNodeTitle')}
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText={t('settings.add')}
        cancelText={t('settings.cancel')}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('settings.providerPlaceholder')}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <Input placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
          <InputNumber
            style={{ width: '100%' }}
            placeholder={t('settings.priorityPlaceholder')}
            value={priority}
            onChange={(value) => setPriority(value)}
          />
        </Space>
      </Modal>
    </>
  )
}

/** [env] 段键值表：写 process.env；*_api_key 键只写不读（presence）。 */
function EnvEditor({ ctx }: { ctx: Ctx }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const env = asObject(getPath(ctx.config, 'env')) ?? {}
  const rows = Object.entries(env).map(([key, raw]) => ({ key, raw }))
  const add = () => {
    const id = name.trim()
    if (!id) {
      message.error(t('settings.envNameRequired'))
      return
    }
    void ctx.write(`env.${id}`, value).then(() => {
      setOpen(false)
      setName('')
      setValue('')
    })
  }
  return (
    <>
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={rows}
        locale={{ emptyText: t('settings.noEnvVars') }}
        columns={[
          { dataIndex: 'key', title: t('settings.nameColumn'), width: 200 },
          {
            key: 'value',
            title: t('settings.valueColumn'),
            render: (_, row) =>
              ctx.redacted.has(`env.${row.key}`) ? (
                <Tag color="green">{t('settings.credentialSet')}</Tag>
              ) : (
                <Input
                  key={`${row.key}:${asString(row.raw) ?? ''}`}
                  size="small"
                  defaultValue={asString(row.raw) ?? ''}
                  onBlur={(e) => {
                    const next = e.target.value
                    if (next !== (asString(row.raw) ?? '')) void ctx.write(`env.${row.key}`, next)
                  }}
                  onPressEnter={(e) => {
                    const next = (e.target as HTMLInputElement).value
                    if (next !== (asString(row.raw) ?? '')) void ctx.write(`env.${row.key}`, next)
                  }}
                />
              ),
          },
          {
            key: 'op',
            title: '',
            width: 48,
            render: (_, row) => (
              <Popconfirm
                title={t('settings.deleteKeyConfirm', { key: row.key })}
                onConfirm={() => void ctx.unset(`env.${row.key}`)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        {t('settings.addEnvVar')}
      </Button>
      <Modal
        title={t('settings.addEnvVarTitle')}
        open={open}
        onOk={add}
        onCancel={() => setOpen(false)}
        okText={t('settings.add')}
        cancelText={t('settings.cancel')}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Input
            placeholder={t('settings.envNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {/_api_key$/i.test(name) ? (
            <Input
              // oxlint-disable-next-line no-useless-concat -- 掩码输入；拼接避免明文触发密钥扫描替换
              type={'pass' + 'word'}
              placeholder={t('settings.envSecretValuePlaceholder')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <Input
              placeholder={t('settings.envValuePlaceholder')}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Space>
      </Modal>
    </>
  )
}

// ── 页面 ─────────────────────────────────────────────────────────────

export function SettingsPage({
  api,
  capabilities,
  bootstrap,
  connected,
  activeId,
}: {
  api: WebApi
  capabilities: Record<string, unknown>
  bootstrap: Bootstrap
  connected: boolean
  activeId: string | undefined
}) {
  const { locale, setLocale, t } = useI18n()
  const { message } = App.useApp()
  const { mode, setMode } = useThemeMode()
  const [view, setView] = useState<ConfigView>()
  const [loadError, setLoadError] = useState<string>()
  const [permissionMode, setPermissionMode] = useState<string>()
  const [models, setModels] = useState<ModelsView>()
  const [section, setSection] = useState<SectionKey>('connection')

  const configCapable = capabilities.config === true
  const load = useCallback(async () => {
    try {
      setView(await api.configGet())
      setLoadError(undefined)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api])
  useEffect(() => {
    if (configCapable) void load()
  }, [configCapable, load])
  useEffect(() => {
    if (capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => setPermissionMode(result.mode))
        .catch(() => {})
  }, [api, capabilities.permissionMode])
  useEffect(() => {
    if (capabilities.models === true)
      void api
        .models()
        .then(setModels)
        .catch(() => {})
  }, [api, capabilities.models])

  const write = useCallback(
    async (key: string, value: unknown) => {
      try {
        await api.configSet(key, value)
        await load()
        message.success(t('settings.savedToast'))
      } catch (cause) {
        message.error(
          t('settings.saveFailedToast', {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
        throw cause
      }
    },
    [api, load, message, t],
  )
  const unset = useCallback(
    async (key: string) => {
      try {
        await api.configUnset(key)
        await load()
        message.success(t('settings.resetToast'))
      } catch (cause) {
        message.error(
          t('settings.resetFailedToast', {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
        throw cause
      }
    },
    [api, load, message, t],
  )

  const ctx: Ctx = {
    config: view?.config,
    redacted: new Set(view?.redacted ?? []),
    write,
    unset,
  }

  const scrollTo = (key: SectionKey) => {
    setSection(key)
    document.getElementById(`settings-${key}`)?.scrollIntoView({ behavior: 'smooth' })
  }

  const native = capabilities.native
  const startedAt = new Date(bootstrap.server.startedAt).toLocaleString()
  // web_search.backend 未设置时运行时默认 tavily（宿主注入前收敛），下拉展示同口径
  const webSearchBackend = asString(getPath(ctx.config, 'web_search.backend')) ?? 'tavily'

  return (
    <div className="settings-wrap">
      <nav className="settings-nav">
        <Menu
          mode="inline"
          selectedKeys={[section]}
          items={SECTIONS.map((item) => ({ key: item.key, label: t(item.labelKey) }))}
          onClick={({ key }) => scrollTo(key as SectionKey)}
          style={{ border: 'none', background: 'transparent' }}
        />
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          <Typography.Title level={4} style={{ marginTop: 0, textAlign: 'center' }}>
            {t('settings.title')}
          </Typography.Title>
          {!configCapable && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title={t('settings.configUnavailable')}
            />
          )}
          {loadError && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              title={t('settings.configLoadFailed', { error: loadError })}
            />
          )}

          {/* 连接状态 */}
          <Typography.Title level={5} id="settings-connection">
            {t('settings.sectionConnection')}
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title={t('settings.status')}>
              <Tag color={connected ? 'green' : 'red'}>
                {connected ? t('settings.connected') : t('settings.disconnected')}
              </Tag>
            </Row>
            <Row title={t('settings.sessionId')}>{activeId ?? t('settings.noActiveSession')}</Row>
            <Row title={t('settings.serverVersion')}>v{bootstrap.server.version}</Row>
            <Row title={t('settings.workingDir')}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {bootstrap.workspace.cwd}
              </Typography.Text>
            </Row>
          </Card>

          {/* 外观 */}
          <Typography.Title level={5} id="settings-appearance">
            {t('settings.sectionAppearance')}
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title={t('settings.uiTheme')} hint={t('settings.uiThemeHint')}>
              <Segmented
                value={mode}
                options={[
                  { label: t('settings.followSystem'), value: 'system' },
                  { label: t('settings.themeLight'), value: 'light' },
                  { label: t('settings.themeDark'), value: 'dark' },
                ]}
                onChange={(value) => setMode(value as 'system' | 'light' | 'dark')}
              />
            </Row>
            <Row title={t('common.language')} hint={t('common.languageHint')}>
              <Segmented
                value={locale}
                options={[
                  { label: t('common.languageZh'), value: 'zh' },
                  { label: t('common.languageEn'), value: 'en' },
                ]}
                onChange={(value) => setLocale(value as 'zh' | 'en')}
              />
            </Row>
            {configCapable && (
              <>
                <TextField
                  ctx={ctx}
                  configKey="ui.theme"
                  title={t('settings.tuiTheme')}
                  hint={t('settings.tuiThemeHint')}
                />
                <BoolField
                  ctx={ctx}
                  configKey="ui.color"
                  title={t('settings.tuiColor')}
                  hint={t('settings.tuiColorHint')}
                  defaultValue
                />
              </>
            )}
          </Card>

          {/* 模型选择 */}
          <Typography.Title level={5} id="settings-models">
            {t('settings.sectionModels')}
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            {models && (
              <Row title={t('settings.defaultModel')} hint={t('settings.defaultModelHint')}>
                <Select
                  style={{ minWidth: 240 }}
                  value={
                    asString(getPath(ctx.config, 'preferences.model')) ?? models.current ?? null
                  }
                  options={models.options.map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))}
                  onChange={(value: string) => void write('preferences.model', value)}
                />
              </Row>
            )}
            {configCapable && (
              <>
                <TextField
                  ctx={ctx}
                  configKey="provider.default"
                  title={t('settings.defaultProvider')}
                  hint={t('settings.defaultProviderHint')}
                />
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>{t('settings.customModels')}</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    {t('settings.customModelsDesc')}
                  </div>
                  <AliasesEditor ctx={ctx} />
                </div>
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>{t('settings.customEndpoints')}</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    {t('settings.customEndpointsDesc')}
                  </div>
                  <ProvidersEditor ctx={ctx} />
                </div>
                <CredentialField
                  ctx={ctx}
                  configKey="auth.anthropic_api_key"
                  title="Anthropic API Key"
                  hint={t('settings.anthropicKeyHint')}
                />
                <BoolField
                  ctx={ctx}
                  configKey="auth.skipAuth"
                  title={t('settings.skipAuth')}
                  hint={t('settings.skipAuthHint')}
                />
              </>
            )}
          </Card>

          {/* 权限模式 */}
          <Typography.Title level={5} id="settings-permission">
            {t('settings.sectionPermission')}
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            {permissionMode !== undefined && (
              <Row title={t('settings.currentMode')} hint={t('settings.currentModeHint')}>
                <Segmented
                  value={permissionMode}
                  options={PERMISSION_MODES.map((item) => ({
                    value: item.value,
                    label: t(item.labelKey),
                  }))}
                  onChange={(value) => {
                    void api.setPermissionMode(value).then((result) => {
                      setPermissionMode(result.mode)
                      message.success(t('chat.modeSwitched'))
                    })
                  }}
                />
              </Row>
            )}
            {configCapable && (
              <EnumField
                ctx={ctx}
                configKey="permissions.mode"
                title={t('settings.defaultPermissionMode')}
                hint={t('settings.defaultPermissionModeHint')}
                options={PERMISSION_MODES.map((item) => ({
                  value: item.value,
                  label: `${t(item.labelKey)} — ${t(item.descKey)}`,
                }))}
              />
            )}
          </Card>

          {/* 模型与推理 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-reasoning">
                {t('settings.sectionReasoning')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <EnumField
                  ctx={ctx}
                  configKey="preferences.reasoningEffort"
                  title={t('settings.reasoningEffort')}
                  hint="preferences.reasoningEffort"
                  options={[
                    { value: 'low', label: 'low' },
                    { value: 'medium', label: 'medium' },
                    { value: 'high', label: 'high' },
                  ]}
                />
                <EnumField
                  ctx={ctx}
                  configKey="router.type"
                  title={t('settings.routerType')}
                  hint={t('settings.routerTypeHint')}
                  options={[
                    { value: 'single', label: 'single' },
                    { value: 'fallback', label: 'fallback' },
                    { value: 'role', label: 'role' },
                  ]}
                />
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>{t('settings.fallbackChain')}</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    {t('settings.fallbackChainDesc')}
                  </div>
                  <RouterChainEditor ctx={ctx} />
                </div>
                <NumberField
                  ctx={ctx}
                  configKey="router.cooldown_seconds"
                  title={t('settings.cooldownSeconds')}
                  hint={t('settings.cooldownSecondsHint')}
                  min={0}
                />
                <BoolField
                  ctx={ctx}
                  configKey="router.allow_cross_provider_tool_use"
                  title={t('settings.crossProviderTools')}
                  hint={t('settings.crossProviderToolsHint')}
                />
                <EnumField
                  ctx={ctx}
                  configKey="context.policy"
                  title={t('settings.contextPolicy')}
                  hint={t('settings.contextPolicyHint')}
                  options={[
                    { value: 'sliding', label: 'sliding' },
                    { value: 'summary', label: 'summary' },
                    { value: 'semantic', label: 'semantic' },
                  ]}
                />
                <NumberField
                  ctx={ctx}
                  configKey="context.max_tokens"
                  title={t('settings.contextMaxTokens')}
                  hint={t('settings.contextMaxTokensHint')}
                  min={1000}
                />
              </Card>
            </>
          )}

          {/* 行为 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-behavior">
                {t('settings.sectionBehavior')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <NumberField
                  ctx={ctx}
                  configKey="runner.maxToolLoopsPerTurn"
                  title={t('settings.maxToolLoops')}
                  hint={t('settings.maxToolLoopsHint')}
                  min={1}
                />
                <BoolField
                  ctx={ctx}
                  configKey="runner.top_level_budget"
                  title={t('settings.topLevelBudget')}
                  hint={t('settings.topLevelBudgetHint')}
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.autoCompact"
                  title={t('settings.autoCompact')}
                  hint="preferences.autoCompact"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.notifications"
                  title={t('settings.notifications')}
                  hint="preferences.notifications"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.promptSuggestions"
                  title={t('settings.promptSuggestions')}
                  hint="preferences.promptSuggestions"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.showTokensCounter"
                  title={t('settings.tokenCounter')}
                  hint="preferences.showTokensCounter"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.terminalProgressBar"
                  title={t('settings.terminalProgressBar')}
                  hint="preferences.terminalProgressBar"
                />
                <TextField
                  ctx={ctx}
                  configKey="tools.windows_shell"
                  title="Windows Shell"
                  hint={t('settings.windowsShellHint')}
                />
                <TagsField
                  ctx={ctx}
                  configKey="tools.pass_through_env"
                  title={t('settings.passThroughEnv')}
                  hint={t('settings.passThroughEnvHint')}
                />
                <TagsField
                  ctx={ctx}
                  configKey="tools.ignore_dirs"
                  title={t('settings.ignoreDirs')}
                  hint={t('settings.ignoreDirsHint')}
                />
                <BoolField
                  ctx={ctx}
                  configKey="evolution.enabled"
                  title="Evolution"
                  hint={t('settings.evolutionHint')}
                />
              </Card>
            </>
          )}

          {/* Web 搜索 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-webSearch">
                {t('settings.sectionWebSearch')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <EnumField
                  ctx={ctx}
                  configKey="web_search.backend"
                  title={t('settings.searchBackend')}
                  hint={t('settings.searchBackendHint')}
                  defaultValue="tavily"
                  options={[
                    { value: 'tavily', label: 'tavily' },
                    { value: 'brave', label: 'brave' },
                    { value: 'custom', label: t('settings.customApiOption') },
                  ]}
                />
                {webSearchBackend === 'tavily' && (
                  <CredentialField
                    ctx={ctx}
                    configKey="web_search.tavily_api_key"
                    title="Tavily API Key"
                    hint={t('settings.tavilyKeyHint')}
                  />
                )}
                {webSearchBackend === 'brave' && (
                  <CredentialField
                    ctx={ctx}
                    configKey="web_search.brave_api_key"
                    title="Brave API Key"
                    hint={t('settings.braveKeyHint')}
                  />
                )}
                {webSearchBackend === 'custom' && (
                  <>
                    <TextField
                      ctx={ctx}
                      configKey="web_search.custom_url"
                      title={t('settings.customSearchUrl')}
                      hint={t('settings.customSearchUrlHint')}
                      width={360}
                    />
                    <CredentialField
                      ctx={ctx}
                      configKey="web_search.custom_api_key"
                      title={t('settings.customApiKey')}
                      hint={t('settings.customApiKeyHint')}
                    />
                  </>
                )}
                <NumberField
                  ctx={ctx}
                  configKey="web_search.max_results"
                  title={t('settings.maxSearchResults')}
                  hint={t('settings.maxSearchResultsHint')}
                  min={1}
                  max={10}
                />
              </Card>
            </>
          )}

          {/* 记忆 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-memory">
                {t('settings.sectionMemory')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <BoolField
                  ctx={ctx}
                  configKey="memory.enabled"
                  title={t('settings.memoryEnabled')}
                  hint="memory.enabled"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.autoMemory"
                  title={t('settings.autoMemory')}
                  hint="preferences.autoMemory"
                />
                <BoolField
                  ctx={ctx}
                  configKey="preferences.typedMemory"
                  title={t('settings.typedMemory')}
                  hint="preferences.typedMemory"
                />
                <NumberField
                  ctx={ctx}
                  configKey="memory.max_body_lines"
                  title={t('settings.memoryBodyLines')}
                  hint={t('settings.memoryBodyLinesHint')}
                  min={1}
                />
                <TextField
                  ctx={ctx}
                  configKey="memory.paths.global"
                  title={t('settings.memoryGlobalPath')}
                  hint={t('settings.memoryGlobalPathHint')}
                />
                <TextField
                  ctx={ctx}
                  configKey="memory.paths.project"
                  title={t('settings.memoryProjectPath')}
                  hint={t('settings.memoryProjectPathHint')}
                />
              </Card>
            </>
          )}

          {/* 定时任务（W-17）：enabled 是用户级 config（机器所有者面，项目级 forbidden）；
              daemon 在场性是触发条件的另一半，只读展示。 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-tasks">
                {t('settings.sectionTasks')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <TasksSchedulerStatus api={api} />
                <BoolField
                  ctx={ctx}
                  configKey="tasks.enabled"
                  title={t('settings.tasksEnabled')}
                  hint={t('settings.tasksEnabledHint')}
                />
                <NumberField
                  ctx={ctx}
                  configKey="tasks.max_concurrent"
                  title={t('settings.tasksMaxConcurrent')}
                  hint={t('settings.tasksMaxConcurrentHint')}
                  min={1}
                  max={8}
                />
                <NumberField
                  ctx={ctx}
                  configKey="tasks.journal_retention"
                  title={t('settings.journalRetention')}
                  hint={t('settings.journalRetentionHint')}
                  min={10}
                  max={10000}
                />
              </Card>
            </>
          )}

          {/* 语言 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-language">
                {t('settings.sectionLanguage')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <Row title={t('settings.replyLanguage')} hint={t('settings.replyLanguageHint')}>
                  <Segmented
                    value={asString(getPath(ctx.config, 'preferences.language')) ?? 'system'}
                    options={[
                      { label: t('settings.followSystem'), value: 'system' },
                      { label: t('common.languageZh'), value: 'chinese' },
                      { label: 'English', value: 'english' },
                    ]}
                    onChange={(value) => void write('preferences.language', value)}
                  />
                </Row>
                <EnumField
                  ctx={ctx}
                  configKey="preferences.outputStyle"
                  title={t('settings.outputStyle')}
                  hint="preferences.outputStyle"
                  options={[
                    { value: 'default', label: 'default' },
                    { value: 'concise', label: 'concise' },
                    { value: 'explanatory', label: 'explanatory' },
                  ]}
                />
              </Card>
            </>
          )}

          {/* Agent 预设 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-agents">
                {t('settings.sectionAgents')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <NumberField
                  ctx={ctx}
                  configKey="subagent.max_depth"
                  title={t('settings.subagentMaxDepth')}
                  hint={t('settings.subagentMaxDepthHint')}
                  min={1}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.max_concurrent"
                  title={t('settings.subagentMaxConcurrent')}
                  hint={t('settings.subagentMaxConcurrentHint')}
                  min={1}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.costUSDMax"
                  title={t('settings.subagentBudgetCost')}
                  hint={t('settings.subagentBudgetCostHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.tokenMax"
                  title={t('settings.subagentBudgetTokens')}
                  hint={t('settings.subagentBudgetTokensHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="subagent.default_budget.timeMsMax"
                  title={t('settings.subagentBudgetTime')}
                  hint={t('settings.subagentBudgetTimeHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="skills.index_budget"
                  title={t('settings.skillsIndexBudget')}
                  hint={t('settings.skillsIndexBudgetHint')}
                  min={0}
                />
              </Card>
              <Card size="small" title={t('settings.reflectionCard')} style={{ marginBottom: 24 }}>
                <BoolField
                  ctx={ctx}
                  configKey="reflection.enabled"
                  title={t('settings.reflectionEnabled')}
                  hint={t('settings.reflectionEnabledHint')}
                  defaultValue
                />
                <BoolField
                  ctx={ctx}
                  configKey="reflection.triggers.on_error"
                  title={t('settings.reflectionOnError')}
                  hint={t('settings.reflectionOnErrorHint')}
                  defaultValue
                />
                <BoolField
                  ctx={ctx}
                  configKey="reflection.triggers.on_compact"
                  title={t('settings.reflectionOnCompact')}
                  hint={t('settings.reflectionOnCompactHint')}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.triggers.every_n_turns"
                  title={t('settings.reflectionEveryNTurns')}
                  hint={t('settings.reflectionEveryNTurnsHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.cooldown_seconds"
                  title={t('settings.reflectionCooldown')}
                  hint={t('settings.reflectionCooldownHint')}
                  min={0}
                />
                <TextField
                  ctx={ctx}
                  configKey="reflection.model_role"
                  title={t('settings.reflectionModelRole')}
                  hint={t('settings.reflectionModelRoleHint')}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.costUSDMax"
                  title={t('settings.runBudgetCost')}
                  hint={t('settings.runBudgetCostHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.tokenMax"
                  title={t('settings.runBudgetTokens')}
                  hint={t('settings.runBudgetTokensHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.run_budget.timeMsMax"
                  title={t('settings.runBudgetTime')}
                  hint={t('settings.runBudgetTimeHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.session_token_budget"
                  title={t('settings.sessionTokenBudget')}
                  hint={t('settings.sessionTokenBudgetHint')}
                  min={0}
                />
                <EnumField
                  ctx={ctx}
                  configKey="reflection.persist"
                  title={t('settings.persist')}
                  hint={t('settings.persistHint')}
                  options={[
                    { value: 'manual', label: 'manual' },
                    { value: 'auto', label: 'auto' },
                    { value: 'off', label: 'off' },
                  ]}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.inject_max_lessons"
                  title={t('settings.injectMaxLessons')}
                  hint={t('settings.injectMaxLessonsHint')}
                  min={0}
                />
                <NumberField
                  ctx={ctx}
                  configKey="reflection.inject_max_bytes"
                  title={t('settings.injectMaxBytes')}
                  hint={t('settings.injectMaxBytesHint')}
                  min={0}
                />
              </Card>
            </>
          )}

          {/* 高级 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-advanced">
                {t('settings.sectionAdvanced')}
              </Typography.Title>
              <Card size="small" style={{ marginBottom: 24 }}>
                <div
                  style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--ant-color-border-secondary)',
                  }}
                >
                  <Typography.Text strong>{t('settings.envSection')}</Typography.Text>
                  <div className="settings-row-desc" style={{ marginBottom: 8 }}>
                    {t('settings.envSectionDesc')}
                  </div>
                  <EnvEditor ctx={ctx} />
                </div>
                <NumberField
                  ctx={ctx}
                  configKey="native.ipc_max_line_bytes"
                  title={t('settings.ipcMaxLineBytes')}
                  hint={t('settings.ipcMaxLineBytesHint')}
                  min={1024}
                />
                <EnumField
                  ctx={ctx}
                  configKey="telemetry.sink"
                  title={t('settings.telemetrySink')}
                  hint={t('settings.telemetrySinkHint')}
                  options={[
                    { value: 'local', label: 'local' },
                    { value: 'otel', label: 'otel' },
                  ]}
                />
                <TextField
                  ctx={ctx}
                  configKey="telemetry.otel.endpoint"
                  title="OTEL Endpoint"
                  hint="telemetry.otel.endpoint"
                />
                <TextField
                  ctx={ctx}
                  configKey="plugins.market"
                  title={t('settings.pluginsMarket')}
                  hint={t('settings.pluginsMarketHint')}
                />
                <TagsField
                  ctx={ctx}
                  configKey="plugins.builtin_disabled"
                  title={t('settings.builtinDisabled')}
                  hint={t('settings.builtinDisabledHint')}
                />
                <NumberField
                  ctx={ctx}
                  configKey="preferences.cleanupPeriod"
                  title={t('settings.cleanupPeriod')}
                  hint={t('settings.cleanupPeriodHint')}
                  min={1}
                  max={365}
                />
              </Card>
              <JsonSectionField
                ctx={ctx}
                section="prompt"
                title={t('settings.promptSection')}
                hint={t('settings.promptSectionHint')}
              />
              <Card size="small" title={t('settings.webConsole')} style={{ marginBottom: 24 }}>
                <Row title={t('settings.webAutoStart')} hint={t('settings.webAutoStartHint')}>
                  <Switch checked={asBool(getPath(ctx.config, 'web.enabled')) ?? true} disabled />
                </Row>
                <NumberField
                  ctx={ctx}
                  configKey="web.port"
                  title={t('settings.webPort')}
                  hint={t('settings.webPortHint')}
                  min={0}
                  max={65535}
                />
                <TextField
                  ctx={ctx}
                  configKey="web.terminal.shell"
                  title={t('settings.terminalShell')}
                  hint={t('settings.terminalShellHint')}
                  placeholder="$SHELL"
                />
                <NumberField
                  ctx={ctx}
                  configKey="web.terminal.font_size"
                  title={t('settings.terminalFontSize')}
                  hint={t('settings.terminalFontSizeHint')}
                  min={9}
                  max={32}
                />
                <NumberField
                  ctx={ctx}
                  configKey="web.terminal.scrollback"
                  title={t('settings.terminalScrollback')}
                  hint={t('settings.terminalScrollbackHint')}
                  min={100}
                  max={100000}
                />
              </Card>
            </>
          )}

          {/* 安全沙箱 */}
          {configCapable && (
            <>
              <Typography.Title level={5} id="settings-sandbox">
                {t('settings.sectionSandbox')}
              </Typography.Title>
              <JsonSectionField
                ctx={ctx}
                section="sandbox"
                title={t('settings.sandboxSection')}
                hint={t('settings.sandboxSectionHint')}
              />
            </>
          )}

          {/* 系统信息 */}
          <Typography.Title level={5} id="settings-system">
            {t('settings.sectionSystem')}
          </Typography.Title>
          <Card size="small" style={{ marginBottom: 24 }}>
            <Row title={t('settings.serverId')}>
              <Typography.Text code style={{ fontSize: 12 }}>
                {bootstrap.server.serverId}
              </Typography.Text>
            </Row>
            <Row title={t('settings.startedAt')}>{startedAt}</Row>
            <Row title={t('settings.nativeModules')}>
              {native && typeof native === 'object' ? (
                <Space size={4}>
                  {Object.entries(native as Record<string, unknown>).map(([name, state]) => (
                    <Tag
                      key={name}
                      color={state === true ? 'green' : state === 'probing' ? 'gold' : 'default'}
                    >
                      {name}:{' '}
                      {state === true ? 'loaded' : state === 'probing' ? 'probing' : 'not loaded'}
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">unavailable</Typography.Text>
              )}
            </Row>
            {view?.files && (
              <>
                <Row title={t('settings.userConfigFile')}>
                  <Typography.Text code copyable style={{ fontSize: 12 }}>
                    {view.files.user}
                  </Typography.Text>
                </Row>
                <Row title={t('settings.projectConfigFile')}>
                  <Typography.Text code copyable style={{ fontSize: 12 }}>
                    {view.files.project}
                  </Typography.Text>
                </Row>
              </>
            )}
            {view && view.warnings.length > 0 && (
              <Row title={t('settings.configWarnings')}>
                <div style={{ fontSize: 12 }}>
                  {view.warnings.map((warning) => (
                    <div key={warning}>
                      <Typography.Text type="warning">{warning}</Typography.Text>
                    </div>
                  ))}
                </div>
              </Row>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
