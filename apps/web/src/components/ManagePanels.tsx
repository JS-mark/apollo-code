'use client'

/**
 * 管理页四域面板（WEB-EXT-MANAGE-MARKET-r1 §S3.2–§S3.5）：
 * Memory（markdown 编辑/导入导出）/ Skills（安装/卸载/详情/热重扫）/ MCP
 * （add/remove/域级 reload/inspect）/ Plugins（三源 inventory + approve 权限清单）。
 * 全部走 tagged-union actions，零直连文件系统。
 */
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  App,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { TaskRunView, TaskSchedulerStatusView, TaskView, WebApi } from '../lib/api'
import { formatSchedule } from '../lib/api'
import { useI18n } from '../lib/i18n'
import {
  CountBadge,
  ItemCard,
  KeyValueEditor,
  Notice,
  PanelIntro,
  PanelToolbar,
  StatusDot,
  downloadJson,
  formatTime,
  installableMarketSource,
  marketErrorMessage,
  useAction,
  useInventory,
} from './manage-shared'
import { Markdown } from './Markdown'
import { MarkdownMemoEditor } from './MarkdownMemoEditor'

// ── Tasks（W-17 批次 4，只读）─────────────────────────────────────────

/** 任务调度面板：调度器状态 + 任务定义 + 运行 journal。写操作只在 daemon/CLI。 */
export function TasksPanel({ api }: { api: WebApi }) {
  const { message } = App.useApp()
  const { t } = useI18n()
  const [status, setStatus] = useState<TaskSchedulerStatusView>()
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [runs, setRuns] = useState<TaskRunView[]>([])
  const [taskFilter, setTaskFilter] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    void api
      .tasks()
      .then((view) => {
        if (cancelled) return
        setStatus(view.status)
        setTasks(view.tasks)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    void api
      .taskRuns(taskFilter, 20)
      .then((view) => {
        if (!cancelled) setRuns(view.runs)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [api, taskFilter, tick])

  const reload = () => setTick((value) => value + 1)
  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await api.taskSetEnabled(id, enabled)
        message.success(enabled ? t('manage.taskEnabled') : t('manage.taskDisabled'))
        reload()
      } catch (cause) {
        message.error(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, message],
  )
  const removeTask = useCallback(
    async (id: string) => {
      try {
        await api.taskRemove(id)
        message.success(t('manage.taskDeleted'))
        if (taskFilter === id) setTaskFilter(undefined)
        reload()
      } catch (cause) {
        message.error(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, message, taskFilter],
  )
  const statusColor = !status
    ? 'gray'
    : !status.enabled
      ? 'gray'
      : status.daemonRunning
        ? 'green'
        : 'orange'
  const statusText = !status
    ? t('manage.statusLoading')
    : !status.enabled
      ? t('manage.taskNotEnabled')
      : status.daemonRunning
        ? t('manage.daemonRunning', { pid: status.pid ?? '?' })
        : t('manage.daemonNotRunning')

  const runStatusColor = (run: TaskRunView): string =>
    run.status === 'completed'
      ? 'green'
      : run.status === 'running'
        ? 'blue'
        : run.status === 'failed'
          ? 'red'
          : 'default'

  return (
    <div>
      <PanelToolbar>
        <StatusDot color={statusColor} text={statusText} />
        <Button icon={<ReloadOutlined />} aria-label={t('manage.refreshTasks')} onClick={reload} />
      </PanelToolbar>
      <Notice message={error} />
      <Table<TaskView>
        size="small"
        rowKey="id"
        dataSource={tasks}
        pagination={false}
        locale={{ emptyText: <Empty description={t('manage.noTaskDefs')} /> }}
        columns={[
          {
            title: t('manage.colTask'),
            dataIndex: 'name',
            render: (_, task) => (
              <Space size={6}>
                <Typography.Text strong>{task.name}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {task.id}
                </Typography.Text>
              </Space>
            ),
          },
          { title: t('manage.colSchedule'), render: (_, task) => formatSchedule(task.schedule) },
          {
            title: t('manage.status'),
            dataIndex: 'enabled',
            width: 90,
            render: (enabled: boolean, task) => (
              <Switch
                size="small"
                checked={enabled}
                checkedChildren={t('manage.enable')}
                unCheckedChildren={t('manage.deactivate')}
                onChange={(checked) => void setEnabled(task.id, checked)}
              />
            ),
          },
          { title: 'cwd', dataIndex: 'cwd', ellipsis: true },
          {
            title: '',
            width: 48,
            render: (_, task) => (
              <Popconfirm
                title={t('manage.deleteTaskConfirm', { name: task.name })}
                description={t('manage.deleteTaskDesc')}
                okButtonProps={{ danger: true }}
                onConfirm={() => void removeTask(task.id)}
              >
                <Tooltip title={t('manage.deleteTask')}>
                  <Button
                    size="small"
                    danger
                    type="text"
                    aria-label={t('manage.deleteTaskAria', { name: task.name })}
                    icon={<DeleteOutlined />}
                  />
                </Tooltip>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 20, marginBottom: 8 }}>
        {t('manage.runHistory')}
      </Typography.Title>
      <Space style={{ marginBottom: 8 }}>
        <Select
          allowClear
          placeholder={t('manage.allTasks')}
          style={{ minWidth: 200 }}
          value={taskFilter}
          onChange={(value) => setTaskFilter(value)}
          options={tasks.map((task) => ({ value: task.id, label: `${task.name} (${task.id})` }))}
        />
      </Space>
      <Table<TaskRunView>
        size="small"
        rowKey="runId"
        dataSource={runs}
        pagination={false}
        locale={{ emptyText: <Empty description={t('manage.noRuns')} /> }}
        columns={[
          {
            title: t('manage.colScheduledFor'),
            dataIndex: 'scheduledFor',
            width: 150,
            render: (ms: number) => formatEpoch(ms),
          },
          {
            title: t('manage.colResult'),
            dataIndex: 'status',
            width: 110,
            render: (_, run) => (
              <Space size={6}>
                <Tag color={runStatusColor(run)}>{run.status}</Tag>
                {run.exitCode !== undefined && run.exitCode !== 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    exit {run.exitCode}
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          },
          {
            title: t('manage.colError'),
            render: (_, run) => run.error?.message ?? '',
            ellipsis: true,
          },
          {
            title: t('manage.colSession'),
            dataIndex: 'sessionId',
            width: 140,
            render: (sessionId: string | undefined) =>
              sessionId ? (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {sessionId}
                </Typography.Text>
              ) : (
                ''
              ),
          },
        ]}
      />
    </div>
  )
}

function formatEpoch(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// ── Memory（§S3.2）────────────────────────────────────────────────────

type MemoryRecord = {
  id: string
  content: string
  tags: readonly string[]
  pinned: boolean
  source: string
  actor?: string
  updatedAt: string
}

type MemoryEditorState = {
  record?: MemoryRecord
  content: string
  tags: string[]
  pinned: boolean
}

function MemoryPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{
    scopeLabel: string
    searchAvailable: boolean
    items: { items: MemoryRecord[] }
  }>(api, 'memory')
  const { notice, setNotice, run } = useAction(api, 'memory')
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MemoryRecord[]>()
  const [editor, setEditor] = useState<MemoryEditorState>()
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importStrategy, setImportStrategy] = useState<'skip' | 'overwrite' | 'rename'>('skip')
  const [importReport, setImportReport] = useState<string>()

  const items = results ?? data?.items?.items ?? []
  const search = useCallback(async () => {
    const result = await run({ action: 'search', query }, (value) => {
      setResults((value as { items: MemoryRecord[] }).items)
    })
    if (result === undefined) setNotice(t('manage.searchFailed'))
  }, [query, run])

  const saveEditor = useCallback(async () => {
    if (!editor) return
    setSaving(true)
    setNotice(undefined)
    try {
      if (editor.record) {
        await api.managementAction('memory', {
          action: 'update',
          id: editor.record.id,
          content: editor.content,
          tags: editor.tags,
          expectedUpdatedAt: editor.record.updatedAt,
        })
      } else {
        await api.managementAction('memory', {
          action: 'create',
          content: editor.content,
          tags: editor.tags,
          pinned: editor.pinned,
        })
      }
      setEditor(undefined)
      reload()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.includes('memory_conflict') || message.includes('changed concurrently')) {
        setEditor(undefined)
        reload()
        setNotice(t('manage.memoryConflictRefreshed'))
      } else {
        setNotice(message)
      }
    } finally {
      setSaving(false)
    }
  }, [api, editor, reload])

  const exportAll = useCallback(async () => {
    const doc = await run({ action: 'export' }, undefined)
    if (doc) downloadJson(`volund-memory-export-${new Date().toISOString().slice(0, 10)}.json`, doc)
  }, [run])

  const doImport = useCallback(
    async (dryRun: boolean) => {
      await run(
        { action: 'import', serialized: importText, strategy: importStrategy, dryRun },
        (value) => {
          const report = value as { applied: number; total: number; dryRun: boolean }
          setImportReport(
            t('manage.importReport', {
              mode: t(report.dryRun ? 'manage.importPreview' : 'manage.import'),
              applied: report.applied,
              total: report.total,
              dry: report.dryRun ? t('manage.importDryNote') : '',
            }),
          )
          if (!report.dryRun) reload()
        },
      )
    },
    [importStrategy, importText, reload, run],
  )

  if (error) return <Notice message={error} />
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro title={t('manage.memoryTitle')} description={t('manage.memoryDesc')} />
        <CountBadge scopeLabel={data?.scopeLabel ?? '…'} count={items.length} />
      </div>
      <PanelToolbar>
        <Space wrap>
          <Input.Search
            placeholder={
              data?.searchAvailable ? t('manage.searchMemory') : t('manage.searchUnavailable')
            }
            value={query}
            disabled={!data?.searchAvailable}
            allowClear
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void search()}
            style={{ width: 300 }}
          />
          {results && (
            <Button size="small" onClick={() => setResults(undefined)}>
              {t('manage.clearSearch')}
            </Button>
          )}
        </Space>
        <Space wrap>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditor({ content: '', tags: [], pinned: false })}
          >
            {t('manage.create')}
          </Button>
          <Button onClick={() => setImportOpen(true)}>{t('manage.import')}</Button>
          <Button onClick={() => void exportAll()}>{t('manage.export')}</Button>
        </Space>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {items.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description={query ? t('manage.noMemoryMatch') : t('manage.noMemoryYet')}>
              {!query && (
                <Button
                  type="primary"
                  onClick={() => setEditor({ content: '', tags: [], pinned: false })}
                >
                  {t('manage.createMemory')}
                </Button>
              )}
            </Empty>
          </div>
        )}
        {items.map((record) => (
          <ItemCard key={record.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Typography.Paragraph
                  style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}
                  ellipsis={{ rows: 3 }}
                >
                  {record.pinned && '📌 '}
                  {record.content.slice(0, 240) || t('manage.emptyContent')}
                </Typography.Paragraph>
                <Space size={6} wrap>
                  {record.tags.map((tag) => (
                    <Tag key={tag} style={{ marginInlineEnd: 0 }}>
                      {tag}
                    </Tag>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {record.id.slice(0, 8)} · {formatTime(record.updatedAt)}
                  </Typography.Text>
                </Space>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    setEditor({
                      record,
                      content: record.content,
                      tags: [...record.tags],
                      pinned: record.pinned,
                    })
                  }
                >
                  {t('manage.edit')}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run(
                      {
                        action: record.pinned ? 'unpin' : 'pin',
                        id: record.id,
                        expectedUpdatedAt: record.updatedAt,
                      },
                      reload,
                    )
                  }
                >
                  {record.pinned ? t('manage.unpin') : t('manage.pin')}
                </Button>
                <Popconfirm
                  title={t('manage.deleteMemoryConfirm')}
                  onConfirm={() =>
                    void run(
                      { action: 'delete', id: record.id, expectedUpdatedAt: record.updatedAt },
                      reload,
                    )
                  }
                >
                  <Button type="text" size="small" danger>
                    {t('manage.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <Modal
        title={editor?.record ? t('manage.editMemory') : t('manage.createMemory')}
        open={editor !== undefined}
        onCancel={() => setEditor(undefined)}
        width={860}
        okText={t('manage.save')}
        okButtonProps={{ loading: saving }}
        onOk={() => void saveEditor()}
      >
        {editor && (
          <div style={{ display: 'grid', gap: 12 }}>
            <MarkdownMemoEditor
              value={editor.content}
              onChange={(content) => setEditor({ ...editor, content })}
            />
            <Space wrap>
              <Select
                mode="tags"
                tokenSeparators={[',']}
                placeholder={t('manage.tagsPlaceholder')}
                style={{ minWidth: 320 }}
                value={editor.tags}
                onChange={(tags) => setEditor({ ...editor, tags })}
                options={[]}
              />
              <Space>
                <Switch
                  checked={editor.pinned}
                  onChange={(pinned) => setEditor({ ...editor, pinned })}
                />
                <Typography.Text>{t('manage.pin')}</Typography.Text>
              </Space>
            </Space>
          </div>
        )}
      </Modal>
      <Modal
        title={t('manage.importMemory')}
        open={importOpen}
        onCancel={() => {
          setImportOpen(false)
          setImportReport(undefined)
        }}
        footer={null}
        width={640}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Input.TextArea
            rows={8}
            placeholder={t('manage.importMemoryPlaceholder')}
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void file.text().then(setImportText)
            }}
          />
          <Space wrap>
            <Select
              style={{ width: 160 }}
              value={importStrategy}
              onChange={setImportStrategy}
              options={[
                { value: 'skip', label: t('manage.importSkip') },
                { value: 'overwrite', label: t('manage.importOverwrite') },
                { value: 'rename', label: t('manage.importRename') },
              ]}
            />
            <Button disabled={!importText.trim()} onClick={() => void doImport(true)}>
              {t('manage.previewDryRun')}
            </Button>
            <Button
              type="primary"
              disabled={!importText.trim()}
              onClick={() => void doImport(false)}
            >
              {t('manage.import')}
            </Button>
            {importReport && <Typography.Text type="secondary">{importReport}</Typography.Text>}
          </Space>
        </div>
      </Modal>
    </div>
  )
}

// ── Skills（§S3.4）───────────────────────────────────────────────────

type SkillItem = {
  name: string
  description: string
  scope: string
  status: string
  version?: string
  path?: string
}

/** SKILL.md 拆 frontmatter + 正文（正文走 Markdown 渲染）。 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
  if (!match) return { frontmatter: '', body: raw }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' }
}

function SkillsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: SkillItem[] }>(api, 'skill')
  const { notice, setNotice, run } = useAction(api, 'skill')
  const { t } = useI18n()
  const [spec, setSpec] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [detail, setDetail] = useState<{ name: string; raw: string }>()
  const install = useCallback(async () => {
    const result = await run({ action: 'install', spec, scope }, (value) => {
      const { items } = value as { items: SkillItem[] }
      setNotice(
        t('manage.skillsInstalled', {
          count: items.length,
          names: items.map((item) => item.name).join(', ') || t('manage.installNone'),
        }),
      )
      setSpec('')
      reload()
    })
    if (result === undefined) setNotice((current) => current ?? t('manage.installFailed'))
  }, [reload, run, scope, spec])

  if (error) return <Notice message={error} />
  const skills = data?.items ?? []
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro title={t('manage.skillsTitle')} description={t('manage.skillsDesc')} />
        <CountBadge scopeLabel="skills" count={skills.length} unit={t('manage.unitSkills')} />
      </div>
      <PanelToolbar>
        <Space wrap>
          <Input
            style={{ width: 360 }}
            placeholder={t('manage.installSourcePlaceholder')}
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
          />
          <Segmented
            value={scope}
            onChange={(next) => setScope(next as 'user' | 'project')}
            options={[
              { value: 'user', label: t('manage.scopeUser') },
              { value: 'project', label: t('manage.scopeProject') },
            ]}
          />
          <Button type="primary" disabled={!spec.trim()} onClick={() => void install()}>
            {t('manage.install')}
          </Button>
        </Space>
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          {t('manage.rescan')}
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {skills.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description={t('manage.noSkills')} />
          </div>
        )}
        {skills.map((skill) => (
          <ItemCard key={`${skill.name}:${skill.scope}`}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={6} wrap style={{ marginBottom: 2 }}>
                  <Typography.Text strong>/{skill.name}</Typography.Text>
                  <Tag
                    color={
                      skill.scope === 'user' ? 'blue' : skill.scope === 'plugin' ? 'purple' : 'cyan'
                    }
                  >
                    {skill.scope === 'user'
                      ? t('manage.scopeUser')
                      : skill.scope === 'plugin'
                        ? t('manage.scopePlugin')
                        : t('manage.scopeProject')}
                  </Tag>
                  {skill.status === 'disabled' && (
                    <Tag color="warning">{t('manage.stateDisabled')}</Tag>
                  )}
                  {skill.status === 'broken' && <Tag color="error">{t('manage.tagBroken')}</Tag>}
                  {skill.status === 'shadowed' && (
                    <Tag color="default">{t('manage.tagShadowed')}</Tag>
                  )}
                  {skill.version && <Tag color="default">v{skill.version}</Tag>}
                </Space>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0 }}
                  ellipsis={{ rows: 2 }}
                >
                  {skill.description}
                </Typography.Paragraph>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run({ action: 'show', name: skill.name }, (value) => {
                      setDetail({ name: skill.name, raw: (value as { body: string }).body })
                    })
                  }
                >
                  {t('manage.details')}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run(
                      {
                        action: 'setEnabled',
                        name: skill.name,
                        enabled: skill.status === 'disabled',
                      },
                      reload,
                    )
                  }
                >
                  {skill.status === 'disabled' ? t('manage.enable') : t('manage.disable')}
                </Button>
                {(skill.scope === 'user' || skill.scope === 'project') && (
                  <Popconfirm
                    title={t('manage.uninstallConfirm', { name: skill.name })}
                    onConfirm={() =>
                      void run(
                        { action: 'uninstall', name: skill.name, scope: skill.scope },
                        reload,
                      )
                    }
                  >
                    <Button type="text" size="small" danger>
                      {t('manage.uninstall')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <Modal
        title={`/${detail?.name ?? ''} · SKILL.md`}
        open={detail !== undefined}
        onCancel={() => setDetail(undefined)}
        footer={null}
        width={760}
      >
        {detail && <SkillDetail raw={detail.raw} />}
      </Modal>
    </div>
  )
}

function SkillDetail({ raw }: { raw: string }) {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(raw), [raw])
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {frontmatter && (
        <pre
          style={{
            background: 'var(--ant-color-fill-tertiary, #f5f5f5)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflow: 'auto',
          }}
        >
          {frontmatter}
        </pre>
      )}
      <Markdown text={body} />
    </div>
  )
}

// ── MCP（§S3.3）──────────────────────────────────────────────────────

type McpEntry = {
  name: string
  transport: string
  scope?: string
  status?: string
  tools?: number
  detail?: string
}

type McpFormState = {
  name: string
  scope: 'user' | 'project'
  kind: 'stdio' | 'http' | 'sse' | 'streamable-http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
}

const emptyMcpForm = (): McpFormState => ({
  name: '',
  scope: 'user',
  kind: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
})

/** add / 编辑（同名 upsert）共用表单；market 预填走 initialValues。 */
export function McpServerFormModal({
  api,
  open,
  initial,
  onClose,
  onSaved,
}: {
  api: WebApi
  open: boolean
  initial?: Partial<McpFormState>
  onClose: () => void
  onSaved?: () => void
}) {
  const [form, setForm] = useState<McpFormState>({ ...emptyMcpForm(), ...initial })
  const [notice, setNotice] = useState<string>()
  const [saving, setSaving] = useState(false)
  const { t } = useI18n()
  const save = useCallback(async () => {
    setSaving(true)
    setNotice(undefined)
    try {
      await api.managementAction('mcp', {
        action: 'add',
        name: form.name,
        scope: form.scope,
        transport: form.kind,
        ...(form.kind === 'stdio'
          ? { command: form.command, args: form.args, env: form.env }
          : { url: form.url, headers: form.headers }),
      })
      onClose()
      onSaved?.()
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }, [api, form, onClose, onSaved])
  return (
    <Modal
      title={
        initial?.name ? t('manage.editMcpServer', { name: initial.name }) : t('manage.addMcpServer')
      }
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      okText={t('manage.saveAndReload')}
      okButtonProps={{
        loading: saving,
        disabled:
          !form.name.trim() || (form.kind === 'stdio' ? !form.command.trim() : !form.url.trim()),
      }}
      width={720}
    >
      <Notice message={notice} />
      <Form layout="vertical">
        <Space wrap>
          <Form.Item label={t('manage.labelName')}>
            <Input
              style={{ width: 200 }}
              value={form.name}
              disabled={Boolean(initial?.name)}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="my-server"
            />
          </Form.Item>
          <Form.Item label={t('manage.labelScope')}>
            <Segmented
              value={form.scope}
              onChange={(next) => setForm({ ...form, scope: next as 'user' | 'project' })}
              options={[
                { value: 'user', label: t('manage.scopeUser') },
                { value: 'project', label: t('manage.scopeProject') },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('manage.labelTransport')}>
            <Select
              style={{ width: 180 }}
              value={form.kind}
              onChange={(kind) => setForm({ ...form, kind })}
              options={[
                { value: 'stdio', label: t('manage.transportStdio') },
                { value: 'http', label: 'Streamable HTTP' },
                { value: 'sse', label: t('manage.transportSse') },
                { value: 'streamable-http', label: t('manage.transportStreamableAlias') },
              ]}
            />
          </Form.Item>
        </Space>
        {form.kind === 'stdio' ? (
          <>
            <Form.Item label={t('manage.labelCommand')}>
              <Input
                value={form.command}
                onChange={(event) => setForm({ ...form, command: event.target.value })}
                placeholder="npx"
              />
            </Form.Item>
            <Form.Item label={t('manage.labelArgs')}>
              <Select
                mode="tags"
                tokenSeparators={[' ']}
                style={{ width: '100%' }}
                value={form.args}
                onChange={(args) => setForm({ ...form, args })}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                open={false}
              />
            </Form.Item>
            <Form.Item label={t('manage.labelEnv')}>
              <KeyValueEditor value={form.env} onChange={(env) => setForm({ ...form, env })} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item label="URL">
              <Input
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                placeholder="https://mcp.example.com/mcp"
              />
            </Form.Item>
            <Form.Item
              label={
                <>
                  {t('manage.labelHeadersPre')} <code>keyref://mcp.&lt;name&gt;.&lt;field&gt;</code>{' '}
                  {t('manage.labelHeadersPost')}
                </>
              }
            >
              <KeyValueEditor
                value={form.headers}
                onChange={(headers) => setForm({ ...form, headers })}
                secretValues
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  )
}

function McpPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{ items: McpEntry[] }>(api, 'mcp')
  const { notice, setNotice, run } = useAction(api, 'mcp')
  const { t } = useI18n()
  const [formOpen, setFormOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<McpEntry>()
  // OAuth 认证是长pending请求（阻塞到浏览器回调完成，最长 5min）：按 server 名
  // 记 loading 态，其余按钮照常可用。
  const [authing, setAuthing] = useState<string>()
  const [inspect, setInspect] = useState<{
    entry: McpEntry
    tools: { name: string; description?: string }[]
  }>()
  if (error) return <Notice message={error} />
  const entries = data?.items ?? []
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro title="MCP servers" description={t('manage.mcpDesc')} />
        <CountBadge scopeLabel="mcp" count={entries.length} unit={t('manage.unitServers')} />
      </div>
      <PanelToolbar>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditEntry(undefined)
            setFormOpen(true)
          }}
        >
          {t('manage.addServer')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void run({ action: 'reload' }, reload)}>
          {t('manage.reloadMcp')}
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <div style={{ display: 'grid', gap: 8 }}>
        {entries.length === 0 && (
          <div style={{ padding: '36px 0' }}>
            <Empty description={t('manage.noMcp')} />
          </div>
        )}
        {entries.map((entry) => (
          <ItemCard key={entry.name}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <Space size={8} wrap style={{ marginBottom: 2 }}>
                  <Typography.Text strong>{entry.name}</Typography.Text>
                  <Tag color="default">
                    {entry.transport.startsWith('stdio') ? 'stdio' : entry.transport}
                  </Tag>
                  <McpStatusDot status={entry.status} />
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  {entry.scope === 'project' ? t('manage.scopeProject') : t('manage.scopeUser')}
                  {entry.tools !== undefined ? t('manage.toolCount', { count: entry.tools }) : ''}
                  {entry.detail ? ` · ${entry.detail}` : ''}
                </Typography.Text>
              </div>
              <Space size={0} style={{ flexShrink: 0 }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() =>
                    void run({ action: 'inspect', name: entry.name }, (value) =>
                      setInspect(value as { entry: McpEntry; tools: [] }),
                    )
                  }
                >
                  {t('manage.details')}
                </Button>
                <Button type="text" size="small" onClick={() => setEditEntry(entry)}>
                  {t('manage.edit')}
                </Button>
                {!entry.transport.startsWith('stdio') && (
                  <>
                    <Button
                      type="text"
                      size="small"
                      loading={authing === entry.name}
                      onClick={() => {
                        setAuthing(entry.name)
                        setNotice(t('manage.oauthBrowserOpened'))
                        void run({ action: 'login', name: entry.name }, () => reload()).finally(
                          () => setAuthing(undefined),
                        )
                      }}
                    >
                      {t('manage.authenticate')}
                    </Button>
                    <Popconfirm
                      title={t('manage.clearOAuthConfirm', { name: entry.name })}
                      onConfirm={() =>
                        void run({ action: 'logout', name: entry.name }, () => reload())
                      }
                    >
                      <Button type="text" size="small">
                        {t('manage.logout')}
                      </Button>
                    </Popconfirm>
                  </>
                )}
                <Button
                  type="text"
                  size="small"
                  disabled={
                    entry.status !== 'disabled' &&
                    entry.status !== 'connected' &&
                    entry.status !== 'failed'
                  }
                  onClick={() =>
                    void run(
                      {
                        action: 'setEnabled',
                        name: entry.name,
                        enabled: entry.status === 'disabled',
                      },
                      reload,
                    )
                  }
                >
                  {entry.status === 'disabled' ? t('manage.enable') : t('manage.disable')}
                </Button>
                <Popconfirm
                  title={t('manage.removeConfirm', { name: entry.name, scope: entry.scope ?? '?' })}
                  onConfirm={() =>
                    void run({ action: 'remove', name: entry.name, scope: entry.scope }, reload)
                  }
                >
                  <Button type="text" size="small" danger>
                    {t('manage.remove')}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </ItemCard>
        ))}
      </div>
      <McpServerFormModal
        api={api}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={reload}
      />
      {editEntry && (
        <McpServerFormModal
          api={api}
          open
          onClose={() => setEditEntry(undefined)}
          onSaved={reload}
          initial={{
            name: editEntry.name,
            scope: editEntry.scope === 'project' ? 'project' : 'user',
            kind: editEntry.transport.startsWith('stdio') ? 'stdio' : 'http',
          }}
        />
      )}
      <Modal
        title={t('manage.mcpServerDetailTitle', { name: inspect?.entry.name ?? '' })}
        open={inspect !== undefined}
        onCancel={() => setInspect(undefined)}
        footer={null}
        width={680}
      >
        {inspect && (
          <div style={{ display: 'grid', gap: 8 }}>
            <Typography.Text type="secondary">
              {inspect.entry.transport} · {inspect.entry.scope} · {inspect.entry.status}
              {inspect.entry.detail ? ` · ${inspect.entry.detail}` : ''}
            </Typography.Text>
            <Table
              size="small"
              pagination={false}
              dataSource={inspect.tools.map((tool) => ({ key: tool.name, ...tool }))}
              columns={[
                { dataIndex: 'name', title: t('manage.colTools'), width: 240 },
                { dataIndex: 'description', title: t('manage.labelDescription') },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

function McpStatusDot({ status }: { status: string | undefined }) {
  const { t } = useI18n()
  const map: Record<string, { color: string; text: string }> = {
    connected: { color: '#52c41a', text: t('manage.stateConnected') },
    connecting: { color: '#faad14', text: t('manage.stateConnecting') },
    'needs-auth': { color: '#fa8c16', text: t('manage.stateNeedsAuth') },
    failed: { color: '#ff4d4f', text: t('manage.stateFailed') },
    disabled: { color: '#bfbfbf', text: t('manage.stateDisabled') },
  }
  const state = map[status ?? ''] ?? { color: '#bfbfbf', text: status ?? t('manage.stateUnknown') }
  return <StatusDot color={state.color} text={state.text} />
}

// ── Plugins（§S3.5）──────────────────────────────────────────────────

type PluginEntry = {
  name: string
  version: string
  source: 'builtin' | 'dev' | 'market'
  /** 市场插件安装目录（inventory 投影含；approvals 等场景可省）。 */
  dir?: string
  commands?: number
  statusTabs?: number
  lifecycle?: { permissionHash: string; approved: boolean; enabled: boolean; loaded: boolean }
  permissions?: Record<string, unknown>
}

type PluginInventory = {
  domains?: { id: string; label: string; description: string; enabled: boolean }[]
  builtin: PluginEntry[]
  dev: PluginEntry[]
  market: {
    installed: PluginEntry[]
    registry:
      | {
          source: string
          plugins: { name: string; version: string; description?: string; publisher?: string }[]
        }
      | { error: string }
  }
}

function PluginsPanel({ api }: { api: WebApi }) {
  const { data, error, reload } = useInventory<{
    items: { id: string; label: string; description: string; enabled: boolean }[]
  }>(api, 'plugins')
  const { notice, setNotice, run } = useAction(api, 'plugins')
  const { t } = useI18n()
  const [inventory, setInventory] = useState<PluginInventory>()
  const [approve, setApprove] = useState<PluginEntry>()
  const [installing, setInstalling] = useState<string>()
  const [listingDetail, setListingDetail] = useState<
    { name: string; version: string; description?: string; publisher?: string } | undefined
  >()
  const [entryDetail, setEntryDetail] = useState<PluginEntry>()
  const loadInventory = useCallback(async () => {
    await run({ action: 'inventory' }, (value) => setInventory(value as PluginInventory))
  }, [run])
  const combined = useCallback(async () => {
    reload()
    await loadInventory()
  }, [loadInventory, reload])
  const toggleDomain = useCallback(
    async (id: string, enabled: boolean) => {
      await run({ action: 'setDomain', id, enabled }, reload)
    },
    [reload, run],
  )
  const install = useCallback(
    async (name: string) => {
      setInstalling(name)
      setNotice(undefined)
      try {
        await api.managementAction('plugins', { action: 'install', name })
      } catch (cause) {
        setNotice(marketErrorMessage(cause, t))
      } finally {
        setInstalling(undefined)
      }
      await combined()
    },
    [api, combined],
  )

  const entryActions = (entry: PluginEntry) => {
    const actions = []
    if (entry.source === 'market' && entry.lifecycle && !entry.lifecycle.approved)
      actions.push(
        <Button key="approve" size="small" type="primary" onClick={() => setApprove(entry)}>
          {t('manage.approve')}
        </Button>,
      )
    if (entry.lifecycle?.enabled)
      actions.push(
        <Button
          key="disable"
          size="small"
          type="text"
          onClick={() => void run({ action: 'disable', name: entry.name }, () => void combined())}
        >
          {t('manage.disable')}
        </Button>,
      )
    else if (entry.lifecycle?.approved)
      actions.push(
        <Button
          key="enable"
          size="small"
          type="primary"
          onClick={() => void run({ action: 'enable', name: entry.name }, () => void combined())}
        >
          {t('manage.enable')}
        </Button>,
      )
    if (entry.source === 'market')
      actions.push(
        <Popconfirm
          key="uninstall"
          title={t('manage.uninstallConfirm', { name: entry.name })}
          onConfirm={() =>
            void run({ action: 'uninstall', name: entry.name }, () => void combined())
          }
        >
          <Button type="text" size="small" danger>
            {t('manage.uninstall')}
          </Button>
        </Popconfirm>,
      )
    return actions
  }

  const renderEntries = (entries: PluginEntry[], onDetail?: (entry: PluginEntry) => void) => (
    <div style={{ display: 'grid', gap: 8 }}>
      {entries.length === 0 && (
        <Empty description={t('manage.none')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
      {entries.map((entry) => (
        <ItemCard key={entry.name}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              style={{ minWidth: 0, cursor: onDetail ? 'pointer' : undefined }}
              onClick={() => onDetail?.(entry)}
              title={onDetail ? t('manage.viewDetails') : undefined}
            >
              <Space size={8} wrap>
                <Typography.Text strong>{entry.name}</Typography.Text>
                <Tag color="default">v{entry.version}</Tag>
                <PluginLifecycleTag entry={entry} />
              </Space>
            </div>
            <Space size={0}>{entryActions(entry)}</Space>
          </div>
        </ItemCard>
      ))}
    </div>
  )

  if (error) return <Notice message={error} />
  const registry = inventory?.market.registry
  const total =
    (inventory?.builtin.length ?? 0) +
    (inventory?.dev.length ?? 0) +
    (inventory?.market.installed.length ?? 0)
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <PanelIntro title={t('manage.pluginsTitle')} description={t('manage.pluginsDesc')} />
        <CountBadge scopeLabel="plugins" count={total} unit={t('manage.unitPlugins')} />
      </div>
      <PanelToolbar>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('manage.legacyCatalogNote')}
        </Typography.Text>
        <Button icon={<ReloadOutlined />} onClick={() => void combined()}>
          {t('manage.refreshInventory')}
        </Button>
      </PanelToolbar>
      <Notice message={notice} />
      <Tabs
        size="small"
        items={[
          {
            key: 'domains',
            label: t('manage.tabDomains'),
            children: (
              <div style={{ display: 'grid', gap: 8 }}>
                {(data?.items ?? []).map((domain) => (
                  <ItemCard key={domain.id}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <div>
                        <Typography.Text strong>{domain.label}</Typography.Text>
                        <Typography.Paragraph
                          type="secondary"
                          style={{ marginBottom: 0, fontSize: 12 }}
                        >
                          {domain.description}
                        </Typography.Paragraph>
                      </div>
                      <Button
                        type="text"
                        size="small"
                        onClick={() => void toggleDomain(domain.id, !domain.enabled)}
                      >
                        {domain.enabled ? t('manage.disable') : t('manage.enable')}
                      </Button>
                    </div>
                  </ItemCard>
                ))}
              </div>
            ),
          },
          {
            key: 'builtin',
            label: t('manage.tabBuiltin'),
            children: renderEntries(inventory?.builtin ?? []),
          },
          { key: 'dev', label: t('manage.tabDev'), children: renderEntries(inventory?.dev ?? []) },
          {
            key: 'market',
            label: t('manage.tabMarketPlugins'),
            children: (
              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <Typography.Title level={5} style={{ marginTop: 0 }}>
                    {t('manage.installedTitle')}
                  </Typography.Title>
                  {renderEntries(inventory?.market.installed ?? [], setEntryDetail)}
                </div>
                <div>
                  <Typography.Title level={5}>{t('manage.marketSourceTitle')}</Typography.Title>
                  {!registry && (
                    <Typography.Text type="secondary">
                      {t('manage.clickRefreshInventory')}
                    </Typography.Text>
                  )}
                  {registry && 'error' in registry && (
                    <Typography.Text type="warning">{registry.error}</Typography.Text>
                  )}
                  {registry && 'plugins' in registry && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {registry.plugins.length === 0 && (
                        <Empty
                          description={t('manage.marketEmpty')}
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                        />
                      )}
                      {registry.plugins.map((listing) => {
                        const installed = inventory?.market.installed.some(
                          (entry) => entry.name === listing.name,
                        )
                        return (
                          <ItemCard key={listing.name}>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 12,
                              }}
                            >
                              <div
                                style={{ minWidth: 0, cursor: 'pointer' }}
                                onClick={() => setListingDetail(listing)}
                                title={t('manage.viewDetails')}
                              >
                                <Space size={8} wrap>
                                  <Typography.Text strong>{listing.name}</Typography.Text>
                                  <Tag color="default">v{listing.version}</Tag>
                                </Space>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ marginBottom: 0, fontSize: 12 }}
                                  ellipsis={{ rows: 2 }}
                                >
                                  {[listing.publisher, listing.description]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Typography.Paragraph>
                              </div>
                              <Button
                                size="small"
                                type={installed ? 'default' : 'primary'}
                                disabled={installed}
                                loading={installing === listing.name}
                                onClick={() => void install(listing.name)}
                              >
                                {installed ? t('manage.installedTitle') : t('manage.install')}
                              </Button>
                            </div>
                          </ItemCard>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            ),
          },
        ]}
      />
      <Modal
        open={Boolean(listingDetail)}
        onCancel={() => setListingDetail(undefined)}
        centered
        title={listingDetail ? `${listingDetail.name} v${listingDetail.version}` : undefined}
        width={640}
        footer={null}
      >
        {listingDetail && (
          <>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('manage.labelVersion')}>
                {listingDetail.version}
              </Descriptions.Item>
              <Descriptions.Item label={t('manage.labelPublisher')}>
                {listingDetail.publisher ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('manage.labelDescription')}>
                {listingDetail.description ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('manage.labelIndexSource')}>
                <Typography.Text copyable code style={{ fontSize: 12 }}>
                  {registry && 'source' in registry ? registry.source : ''}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('manage.labelInstallEligibility')}>
                {registry && 'source' in registry && installableMarketSource(registry.source)
                  ? t('manage.localSourceInstallable')
                  : t('manage.remoteNeedsTrustRoot')}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
              {t('manage.installShaNote')}
            </Typography.Paragraph>
            {inventory?.market.installed.some((entry) => entry.name === listingDetail.name) ? (
              <Typography.Text type="secondary">
                {t('manage.installedLifecycleNote')}
              </Typography.Text>
            ) : (
              <Button
                type="primary"
                block
                disabled={
                  !(registry && 'source' in registry && installableMarketSource(registry.source))
                }
                loading={installing === listingDetail.name}
                onClick={() => void install(listingDetail.name)}
              >
                {t('manage.installVersion', { version: listingDetail.version })}
              </Button>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={Boolean(entryDetail)}
        onCancel={() => setEntryDetail(undefined)}
        centered
        title={entryDetail ? `${entryDetail.name} v${entryDetail.version}` : undefined}
        width={640}
        footer={null}
      >
        {entryDetail && (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label={t('manage.labelSource')}>
              {entryDetail.source}
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.labelInstallDir')}>
              <Typography.Text copyable code style={{ fontSize: 12 }}>
                {entryDetail.dir}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.labelCommands')}>
              {entryDetail.commands}
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.labelStatusTabs')}>
              {entryDetail.statusTabs}
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.stateApproved')}>
              {entryDetail.lifecycle?.approved ? t('manage.yes') : t('manage.no')}
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.stateEnabled')}>
              {entryDetail.lifecycle?.enabled ? t('manage.yes') : t('manage.no')}
            </Descriptions.Item>
            <Descriptions.Item label={t('manage.stateLoaded')}>
              {entryDetail.lifecycle?.loaded ? t('manage.yes') : t('manage.no')}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
      {approve && (
        <ApproveModal
          api={api}
          entry={approve}
          onClose={() => setApprove(undefined)}
          onApproved={() => {
            setApprove(undefined)
            void combined()
          }}
        />
      )}
    </div>
  )
}

function PluginLifecycleTag({ entry }: { entry: PluginEntry }) {
  const { t } = useI18n()
  if (!entry.lifecycle) return <Tag color="default">{entry.source}</Tag>
  const { approved, enabled, loaded } = entry.lifecycle
  if (loaded) return <StatusDot color="#52c41a" text={t('manage.stateLoaded')} />
  if (enabled) return <StatusDot color="#52c41a" text={t('manage.stateEnabled')} />
  if (approved) return <StatusDot color="#1677ff" text={t('manage.statePendingEnable')} />
  return <StatusDot color="#faad14" text={t('manage.statePendingApprove')} />
}

/** 批准前强制展示权限清单（§S3.5 不变量：未展示前批准不可用；hash 变更高亮）。 */
function ApproveModal({
  api,
  entry,
  onClose,
  onApproved,
}: {
  api: WebApi
  entry: PluginEntry
  onClose: () => void
  onApproved: () => void
}) {
  const [detail, setDetail] = useState<PluginEntry & { permissions?: Record<string, unknown> }>()
  const [notice, setNotice] = useState<string>()
  const { t } = useI18n()
  useEffect(() => {
    void api
      .managementAction('plugins', { action: 'inspect', name: entry.name })
      .then((value) => setDetail(value as PluginEntry))
      .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
  }, [api, entry.name])
  const permissions = detail?.permissions
  return (
    <Modal
      title={t('manage.approvePlugin', { name: entry.name })}
      open
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('manage.cancel')}
        </Button>,
        <Button
          key="approve"
          type="primary"
          disabled={!detail || !permissions}
          onClick={() => {
            void api
              .managementAction('plugins', {
                action: 'approve',
                name: entry.name,
                permissionHash:
                  detail?.lifecycle?.permissionHash ?? entry.lifecycle?.permissionHash,
              })
              .then(onApproved)
              .catch((cause) => setNotice(cause instanceof Error ? cause.message : String(cause)))
          }}
        >
          {t('manage.confirmApprove')}
        </Button>,
      ]}
      width={640}
    >
      <Notice message={notice} />
      {!detail && <Typography.Text type="secondary">{t('manage.readingManifest')}</Typography.Text>}
      {detail && (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text>
            v{detail.version} · permissionHash{' '}
            <code>{(detail.lifecycle?.permissionHash ?? '').slice(0, 16)}…</code>
          </Typography.Text>
          <pre
            style={{
              background: 'var(--ant-color-fill-tertiary, #f5f5f5)',
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(permissions ?? {}, null, 2)}
          </pre>
          <Typography.Text type="secondary">{t('manage.approveNote')}</Typography.Text>
        </div>
      )}
    </Modal>
  )
}

export { MemoryPanel, SkillsPanel, McpPanel, PluginsPanel }
