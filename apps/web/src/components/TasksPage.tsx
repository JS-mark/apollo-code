'use client'

/** 任务页（W-17）：左侧栏一级入口。面板复用 ManagePanels 的 TasksPanel（启停/删除已内置）。 */
import { Typography } from 'antd'

import type { WebApi } from '../lib/api'
import { TasksPanel } from './ManagePanels'

export function TasksPage({ api }: { api: WebApi }) {
  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        任务
      </Typography.Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        定时任务与运行记录。可在此启停/删除任务；创建走 CLI（volund tasks）或对话内 schedule_task
        工具，触发由 volund daemon 独占（F1-01）。
      </Typography.Text>
      <TasksPanel api={api} />
    </section>
  )
}
