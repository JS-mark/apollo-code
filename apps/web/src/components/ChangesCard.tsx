'use client'

/**
 * 消息流变更卡片（对齐 CodeBuddy 的「N 个文件已更改」卡）：
 * - 钉在会话流末尾，随 turn 变化/展开/撤销后刷新（stats 加码面，不轮询）；
 * - 折叠态：文件数 + 净增删行合计 + 「撤销」（最近批次，预览确认门）；
 * - 展开态：每文件一行（类型徽章/路径/+A −D），「审查」= 工作台变更面板
 *   定位该文件的 diff，「打开」= 工作台文件查看器。
 */
import { DownOutlined, HistoryOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Modal, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { WebApi } from '../lib/api'
import { FileTypeIcon } from './FileTypeIcon'

interface ChangeRow {
  path: string
  created: boolean
  batches: number
  lastModifiedAt: string
  allConsumed: boolean
  stats?: {
    linesAdded: number
    linesRemoved: number
    truncated: boolean
    deleted: boolean
  }
}

interface UndoPreview {
  undoable: boolean
  reason?: string
  paths: string[]
  warnings: { path: string; kind: string }[]
}

export function ChangesCard({
  api,
  sessionId,
  turn,
  onOpenChanges,
  onOpenFile,
}: {
  api: WebApi
  sessionId: string | undefined
  /** turn 状态（idle/running）：边沿翻转即刷新（turn 结束的改动由此带回）。 */
  turn: string
  /** 审查：打开工作台「文件变更」标签页并定位该文件。 */
  onOpenChanges(path: string): void
  /** 打开：工作台文件查看器。 */
  onOpenFile(path: string): void
}) {
  const [rows, setRows] = useState<ChangeRow[]>()
  const [expanded, setExpanded] = useState(false)
  const [undoOpen, setUndoOpen] = useState(false)
  const [undoPreview, setUndoPreview] = useState<UndoPreview>()
  const [undoing, setUndoing] = useState(false)

  const reload = useCallback(() => {
    if (sessionId === undefined) {
      setRows(undefined)
      return
    }
    void api
      .changes({ stats: true })
      .then((snapshot) => setRows(snapshot.paths))
      .catch(() => {})
  }, [api, sessionId])

  // 会话切换重置 + turn 边沿刷新（stats 是加码面，不轮询——展开/撤销后另行刷新）。
  useEffect(() => {
    reload()
  }, [reload, turn])

  const toggleExpanded = () => {
    if (!expanded) reload()
    setExpanded((value) => !value)
  }

  const openUndo = useCallback(async () => {
    setUndoPreview(await api.undoPreview().catch(() => undefined))
    setUndoOpen(true)
  }, [api])

  const runUndo = useCallback(async () => {
    setUndoing(true)
    try {
      await api.undo()
      setUndoOpen(false)
      setUndoPreview(undefined)
      reload()
    } catch {
      // 失败经 Modal 关闭即可；错误留在 console
    } finally {
      setUndoing(false)
    }
  }, [api, reload])

  if (rows === undefined || rows.length === 0) return null

  const totals = rows.reduce(
    (acc, row) => ({
      added: acc.added + (row.stats?.linesAdded ?? 0),
      removed: acc.removed + (row.stats?.linesRemoved ?? 0),
    }),
    { added: 0, removed: 0 },
  )
  const pending = rows.filter((row) => !row.allConsumed)

  return (
    <div className="chg-card">
      <div className="chg-card-head" onClick={toggleExpanded}>
        {expanded ? <DownOutlined /> : <RightOutlined />}
        <Typography.Text strong style={{ fontSize: 13 }}>
          {rows.length} 个文件已更改
        </Typography.Text>
        <span className="chg-diff-stat add">+{totals.added}</span>
        <span className="chg-diff-stat del">−{totals.removed}</span>
        <span style={{ flex: 1 }} />
        <Tooltip title="撤销上一批变更">
          <Button
            size="small"
            type="text"
            icon={<HistoryOutlined />}
            aria-label="撤销上一批变更"
            disabled={pending.length === 0}
            onClick={(event) => {
              event.stopPropagation()
              void openUndo()
            }}
          >
            撤销
          </Button>
        </Tooltip>
      </div>
      {expanded &&
        rows.map((row) => {
          const name = row.path.split('/').pop() ?? row.path
          const dir = row.path.slice(0, row.path.length - name.length)
          return (
            <div key={row.path} className="chg-card-row" title={row.path}>
              <FileTypeIcon name={name} />
              <span className="chg-card-name">{name}</span>
              <span className="chg-card-dir">{dir}</span>
              {row.stats && !row.stats.truncated && (
                <>
                  <span className="chg-diff-stat add">+{row.stats.linesAdded}</span>
                  <span className="chg-diff-stat del">−{row.stats.linesRemoved}</span>
                </>
              )}
              {row.allConsumed && <span className="chg-card-consumed">已撤销</span>}
              <span className="chg-card-actions">
                <Button size="small" onClick={() => onOpenChanges(row.path)}>
                  审查
                </Button>
                <Button size="small" onClick={() => onOpenFile(row.path)}>
                  打开
                </Button>
              </span>
            </div>
          )
        })}

      <Modal
        open={undoOpen}
        title="撤销上一批变更"
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !undoPreview?.undoable, loading: undoing }}
        cancelText="取消"
        onOk={() => void runUndo()}
        onCancel={() => setUndoOpen(false)}
      >
        {undoPreview === undefined ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : undoPreview.undoable ? (
          <>
            <Typography.Text>
              将撤销 <strong>{undoPreview.paths.length}</strong> 个文件的上一批变更：
            </Typography.Text>
            {undoPreview.paths.map((path) => (
              <div key={path} style={{ padding: '2px 0' }}>
                <Typography.Text type="secondary">{path}</Typography.Text>
              </div>
            ))}
            {undoPreview.warnings.map((warning) => (
              <Alert
                key={warning.path}
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                title={
                  warning.kind === 'target_modified'
                    ? `${warning.path}: 备份后曾被外部修改，撤销可能覆盖手工改动`
                    : `${warning.path}: 备份对象缺失，该文件将跳过`
                }
              />
            ))}
          </>
        ) : (
          <Typography.Text type="secondary">没有可撤销的批次（no_backup）。</Typography.Text>
        )}
      </Modal>
    </div>
  )
}
