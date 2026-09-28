'use client'

/**
 * 任务视图（W-17 批次 4，只读）：调度器状态 + 任务定义 + 运行 journal。
 * 触发与写操作只在 daemon/CLI（F1-01 单一所有权），移动站只做观测——
 * tab 未激活不拉数据，切回时自动刷新。
 */
import { ReloadOutlined } from '@ant-design/icons'
import { Button, Empty, List, Skeleton, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  GatewayApi,
  type MobileTask,
  type MobileTaskRun,
  type MobileTaskSchedulerStatus,
  type MobileTaskSchedule,
} from '../lib/gateway'

function scheduleLabel(schedule: MobileTaskSchedule): string {
  if (schedule.kind === 'interval') {
    const minutes = Math.round((schedule.everyMs ?? 0) / 60_000)
    return `每 ${minutes} 分钟`
  }
  if (schedule.kind === 'daily') return `每天 ${schedule.at ?? ''}`
  return `每周 ${(schedule.weekdays ?? []).join(',')} ${schedule.at ?? ''}`
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

const RUN_STATUS: Record<MobileTaskRun['status'], { color: string; label: string }> = {
  completed: { color: 'green', label: '完成' },
  running: { color: 'blue', label: '运行中' },
  failed: { color: 'red', label: '失败' },
  missed: { color: 'default', label: '错过' },
  skipped: { color: 'default', label: '跳过' },
}

export function TasksView({ token, active }: { token: string; active: boolean }) {
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
        <Typography.Text strong>任务</Typography.Text>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          aria-label="刷新任务"
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
          调度未启用（本机 config [tasks].enabled）；以下为缓存数据。
        </Typography.Text>
      ) : status && !status.daemonRunning ? (
        <Typography.Text type="warning" style={{ display: 'block', marginBottom: 8 }}>
          daemon 未运行——任务不会触发。
        </Typography.Text>
      ) : null}
      <List
        size="small"
        header={<Typography.Text type="secondary">任务定义</Typography.Text>}
        dataSource={tasks}
        locale={{ emptyText: <Empty description="没有任务定义" /> }}
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
                    {task.enabled ? '启用' : '停用'}
                  </Tag>
                  {filter === task.id ? <Tag color="blue">筛选中</Tag> : null}
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
        header={<Typography.Text type="secondary">运行记录（新→旧）</Typography.Text>}
        dataSource={runs}
        locale={{ emptyText: <Empty description="没有运行记录" /> }}
        renderItem={(run) => (
          <List.Item>
            <List.Item.Meta
              title={
                <span>
                  <Tag color={RUN_STATUS[run.status].color}>{RUN_STATUS[run.status].label}</Tag>
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
