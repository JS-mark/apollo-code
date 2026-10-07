'use client'

/**
 * 任务视图（W-17 批次 4，只读）：调度器状态 + 任务定义 + 运行 journal。
 * 触发与写操作只在 daemon/CLI（F1-01 单一所有权），移动站只做观测——
 * tab 未激活不拉数据，切回时自动刷新。
 */
import { ReloadOutlined } from '@ant-design/icons'
import { Button, Empty, List, Skeleton, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { type DictKey } from '../lib/dict'
import {
  GatewayApi,
  type MobileTask,
  type MobileTaskRun,
  type MobileTaskSchedulerStatus,
  type MobileTaskSchedule,
} from '../lib/gateway'
import { currentLocale, translate, useI18n } from '../lib/i18n'

function scheduleLabel(schedule: MobileTaskSchedule): string {
  if (schedule.kind === 'interval') {
    const minutes = Math.round((schedule.everyMs ?? 0) / 60_000)
    return translate(currentLocale(), 'tasks.everyMinutes', { minutes })
  }
  if (schedule.kind === 'daily')
    return translate(currentLocale(), 'tasks.dailyAt', { at: schedule.at ?? '' })
  return translate(currentLocale(), 'tasks.weeklyAt', {
    weekdays: (schedule.weekdays ?? []).join(','),
    at: schedule.at ?? '',
  })
}

function epochLabel(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const RUN_STATUS: Record<MobileTaskRun['status'], { color: string; key: DictKey }> = {
  completed: { color: 'green', key: 'tasks.runCompleted' },
  running: { color: 'blue', key: 'common.running' },
  failed: { color: 'red', key: 'common.failed' },
  missed: { color: 'default', key: 'tasks.runMissed' },
  skipped: { color: 'default', key: 'tasks.runSkipped' },
}

export function TasksView({ token, active }: { token: string; active: boolean }) {
  const { t } = useI18n()
  const api = useMemo(() => new GatewayApi(token), [token])
  const [status, setStatus] = useState<MobileTaskSchedulerStatus>()
  const [tasks, setTasks] = useState<MobileTask[]>([])
  const [runs, setRuns] = useState<MobileTaskRun[]>([])
  const [filter, setFilter] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const view = await api.tasks()
      setStatus(view.status)
      setTasks(view.tasks)
      setRuns((await api.taskRuns(filter, 20)).runs)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [api, filter])

  useEffect(() => {
    if (active) void load()
  }, [active, load, tick])

  if (loading && !status) return <Skeleton active style={{ padding: 16 }} />

  return (
    <div style={{ padding: 12, overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <Typography.Text strong>{t('tab.tasks')}</Typography.Text>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          aria-label={t('tasks.refresh')}
          onClick={() => setTick((value) => value + 1)}
        />
      </div>
      {error ? (
        <Typography.Text type="danger" style={{ display: 'block', marginBottom: 8 }}>
          {error}
        </Typography.Text>
      ) : null}
      {status && !status.enabled ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          {t('tasks.schedulerDisabled')}
        </Typography.Text>
      ) : status && !status.daemonRunning ? (
        <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
          {t('tasks.daemonDown')}
        </Typography.Text>
      ) : null}
      <List
        size="small"
        header={<Typography.Text type="secondary">{t('tasks.definitions')}</Typography.Text>}
        dataSource={tasks}
        locale={{ emptyText: <Empty description={t('tasks.noDefinitions')} /> }}
        renderItem={(task) => (
          <List.Item
            style={{ cursor: 'pointer' }}
            onClick={() => setFilter(filter === task.id ? undefined : task.id)}
          >
            <List.Item.Meta
              title={
                <span>
                  {task.name}{' '}
                  <Tag color={task.enabled ? 'green' : 'default'}>
                    {task.enabled ? t('tasks.enabled') : t('tasks.disabled')}
                  </Tag>
                  {filter === task.id ? <Tag color="blue">{t('tasks.filtering')}</Tag> : null}
                </span>
              }
              description={`${scheduleLabel(task.schedule)}`}
            />
          </List.Item>
        )}
      />
      <List
        size="small"
        style={{ marginTop: 12 }}
        header={<Typography.Text type="secondary">{t('tasks.runsHeader')}</Typography.Text>}
        dataSource={runs}
        locale={{ emptyText: <Empty description={t('tasks.noRuns')} /> }}
        renderItem={(run) => (
          <List.Item>
            <List.Item.Meta
              title={
                <span>
                  <Tag color={RUN_STATUS[run.status].color}>{t(RUN_STATUS[run.status].key)}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {epochLabel(run.scheduledFor)}
                    {run.exitCode !== undefined && run.exitCode !== 0
                      ? ` · exit ${run.exitCode}`
                      : ''}
                  </Typography.Text>
                </span>
              }
              description={run.error?.message ?? run.sessionId ?? ''}
            />
          </List.Item>
        )}
      />
    </div>
  )
}
