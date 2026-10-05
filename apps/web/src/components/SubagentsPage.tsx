'use client'

/**
 * Subagents 页（SAG-13）：dispatcher 运行注册表的只读管理面——列表/取消。
 * 数据面 = GET /api/v1/subagents；页面打开期间 2s 轮询（注册表是进程本地的，
 * 无独立 SSE 通道；subagent.* 事件只进会话流）。取消 = POST cancel/cancel-all。
 */
import { ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { Button, Empty, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useCallback, useEffect, useState } from 'react'

import type { SubagentRunRow, WebApi } from '../lib/api'

const STATUS_COLOR: Record<SubagentRunRow['status'], string> = {
  running: 'processing',
  completed: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'default',
  interrupted: 'default',
}

const STATUS_LABEL: Record<SubagentRunRow['status'], string> = {
  running: '运行中',
  completed: '已完成',
  partial: '部分结果',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

function duration(row: SubagentRunRow): string {
  const total = Math.max(0, Math.floor(((row.endedAt ?? Date.now()) - row.startedAt) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number) => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function SubagentsPage({ api }: { api: WebApi }) {
  const [runs, setRuns] = useState<readonly SubagentRunRow[]>([])
  const [available, setAvailable] = useState(true)
  const [cancelling, setCancelling] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      const view = await api.subagents()
      setRuns(view.runs)
      setAvailable(true)
    } catch {
      setAvailable(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2_000)
    return () => clearInterval(timer)
  }, [refresh])

  const cancel = useCallback(
    async (sessionId: string) => {
      setCancelling(sessionId)
      try {
        await api.cancelSubagent(sessionId)
        await refresh()
      } finally {
        setCancelling(undefined)
      }
    },
    [api, refresh],
  )

  const cancelAll = useCallback(async () => {
    setCancelling('*')
    try {
      await api.cancelAllSubagents()
      await refresh()
    } finally {
      setCancelling(undefined)
    }
  }, [api, refresh])

  const columns: ColumnsType<SubagentRunRow> = [
    {
      title: 'Agent',
      key: 'agentType',
      width: 160,
      render: (_, row) => row.agentType ?? 'task-agent',
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_, row) => <Tag color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status]}</Tag>,
    },
    {
      title: 'Prompt',
      key: 'prompt',
      ellipsis: true,
      render: (_, row) => (
        <Tooltip title={row.prompt} placement="topLeft">
          <span>{row.promptPreview}</span>
        </Tooltip>
      ),
    },
    { title: '层级', dataIndex: 'depth', key: 'depth', width: 64 },
    { title: '时长', key: 'duration', width: 90, render: (_, row) => duration(row) },
    {
      title: '用量',
      key: 'usage',
      width: 150,
      render: (_, row) =>
        row.usage
          ? `${row.usage.input} in / ${row.usage.output} out` +
            (row.usage.costUSD ? ` · $${row.usage.costUSD.toFixed(4)}` : '')
          : '—',
    },
    {
      title: '工具调用',
      dataIndex: 'toolCalls',
      key: 'toolCalls',
      width: 90,
      render: (value: number | undefined) => value ?? '—',
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) =>
        row.status === 'running' ? (
          <Popconfirm
            title="取消该 subagent？"
            onConfirm={() => void cancel(row.sessionId)}
            disabled={cancelling !== undefined}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<StopOutlined />}
              aria-label={`取消 ${row.agentType ?? 'task-agent'}`}
              loading={cancelling === row.sessionId}
              disabled={cancelling !== undefined}
            />
          </Popconfirm>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ]

  const runningCount = runs.filter((row) => row.status === 'running').length

  return (
    <section className="page" style={{ padding: 24, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Title level={4} style={{ marginTop: 0, flex: 1 }}>
          Subagents{runningCount > 0 ? `（${runningCount} 运行中）` : ''}
        </Typography.Title>
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            aria-label="刷新 subagent 列表"
            onClick={() => void refresh()}
          />
        </Tooltip>
        <Popconfirm
          title="停止全部运行中的 subagent？"
          onConfirm={() => void cancelAll()}
          disabled={runningCount === 0 || cancelling !== undefined}
        >
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            disabled={runningCount === 0 || cancelling !== undefined}
            loading={cancelling === '*'}
          >
            全部停止
          </Button>
        </Popconfirm>
      </div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        子代理运行注册表（本机进程视角）。运行由 Task 工具派发；取消走中断语义，结果以 cancelled
        回传。
      </Typography.Text>
      {!available ? (
        <Empty description="subagents 端口不可用（服务端未装配）" />
      ) : runs.length === 0 ? (
        <Empty description="暂无 subagent 运行" />
      ) : (
        <Table
          size="small"
          rowKey="sessionId"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          dataSource={[...runs]}
          columns={columns}
        />
      )}
    </section>
  )
}
