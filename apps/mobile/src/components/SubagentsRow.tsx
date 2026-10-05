'use client'

/**
 * Subagent 只读运行行（SAG-13）：会话页 composer 上方的常驻窄条——有运行时显示
 * 「● N 运行中」，展开列出全部运行（状态/时长/预览），运行中的行可取消。
 * 数据面 = GET /v1/sessions/active/subagents（relay 经隧道取自本机注册表）；
 * 刷新时机 = 挂载 + tick 信号（page 层在 subagent.* 事件帧到达时递增）+ 30s 兜底。
 */
import { useCallback, useEffect, useState } from 'react'

import type { GatewayApi, SubagentRunRow } from '../lib/gateway'

const STATUS_LABEL: Record<SubagentRunRow['status'], string> = {
  running: '运行中',
  completed: '已完成',
  partial: '部分结果',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

function duration(row: SubagentRunRow, now: number): string {
  const total = Math.max(0, Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function SubagentsRow({
  gateway,
  tick,
  initialRuns,
  initialOpen,
}: {
  gateway: GatewayApi | undefined
  /** page 层在 subagent.dispatched/settled 事件帧到达时递增；0 = 仅挂载拉一次。 */
  tick: number
  /** 测试种子（静态渲染不跑 effect）；生产不传。 */
  initialRuns?: readonly SubagentRunRow[]
  /** 测试种子：初始展开（静态渲染无交互）；生产不传。 */
  initialOpen?: boolean
}) {
  const [runs, setRuns] = useState<readonly SubagentRunRow[]>(initialRuns ?? [])
  const [open, setOpen] = useState(initialOpen ?? false)
  const [cancelling, setCancelling] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    if (!gateway) return
    try {
      const view = await gateway.subagents()
      setRuns(view.runs)
    } catch {
      // 注册表不可达（旧网关/隧道离线）：静默保持上一次视图，窄条本就是辅助面。
    }
  }, [gateway])

  useEffect(() => {
    void refresh()
  }, [refresh, tick])

  // 运行中计时每秒走表；无运行时不空转。
  const runningCount = runs.filter((row) => row.status === 'running').length
  useEffect(() => {
    if (runningCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [runningCount])

  // 兜底轮询：事件帧丢失（弱网）时 30s 收敛一次。
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  if (runs.length === 0) return null

  const cancel = async (sessionId: string) => {
    if (!gateway || cancelling !== undefined) return
    setCancelling(sessionId)
    try {
      await gateway.cancelSubagent(sessionId)
      await refresh()
    } catch {
      // 取消失败（已结算/链路断）：刷新对齐注册表现状。
      await refresh()
    } finally {
      setCancelling(undefined)
    }
  }

  return (
    <div className="subagents-row" role="region" aria-label="subagent 运行">
      <button
        type="button"
        className="subagents-row-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="subagents-row-pulse" aria-hidden />
        Subagents · {runningCount} 运行中 / {runs.length} 总计
        <span className="subagents-row-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="subagents-row-list">
          {runs.map((row) => (
            <div key={row.sessionId} className="subagents-row-item">
              <span className="subagents-row-status">{STATUS_LABEL[row.status]}</span>
              <span className="subagents-row-name">{row.agentType ?? 'task-agent'}</span>
              <span className="subagents-row-preview">{row.promptPreview}</span>
              <span className="subagents-row-duration">{duration(row, now)}</span>
              {row.status === 'running' && (
                <button
                  type="button"
                  className="subagents-row-cancel"
                  disabled={cancelling !== undefined}
                  onClick={() => void cancel(row.sessionId)}
                >
                  {cancelling === row.sessionId ? '取消中…' : '取消'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
