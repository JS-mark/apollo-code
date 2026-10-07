'use client'

/**
 * 消息流变更卡片（对齐 Web 端 ChangesCard / CodeBuddy 的「N 个文件已更改」）：
 * 钉在会话流末尾（Virtuoso Footer），turn 边沿/展开/撤销后刷新（不轮询）。
 * 折叠态给文件数与净增删合计 + 「撤销」（最近批次，预览确认门）；展开态每文件
 * 一行（名称/目录/+A −D），点行内联展开该文件的净效果 diff（unified 直渲，
 * 窄屏不做左右分栏）。数据经网关隧道取自本机 BackupStore（changes.* RPC）。
 */
import { DownOutlined, FileOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons'
import { Alert, Button, Modal } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { ChangeDiff, ChangeRow, GatewayApi, UndoPreview } from '../lib/gateway'
import { useI18n } from '../lib/i18n'

/** unified diff 行分类（meta 行不渲染）。 */
export function diffLineClass(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** 单文件行内 diff：点击展开时按路径直拉（拉过的缓存住，撤销后整缓存失效）。 */
function RowDiff({ diff }: { diff: ChangeDiff | undefined }) {
  const { t } = useI18n()
  if (diff === undefined)
    return (
      <div className="chg-row-diff">
        <LoadingOutlined style={{ fontSize: 12 }} />
      </div>
    )
  if (!diff.tracked)
    return <div className="chg-row-diff chg-row-empty">{t('changes.noBackup')}</div>
  if (diff.truncated)
    return <div className="chg-row-diff chg-row-empty">{t('changes.tooLarge')}</div>
  if (diff.diff.trim() === '')
    return (
      <div className="chg-row-diff chg-row-empty">
        {diff.created ? t('changes.created') : t('changes.noDiff')}
      </div>
    )
  return (
    <div className="chg-row-diff">
      {diff.diff.split('\n').map((line, index) => {
        const kind = diffLineClass(line)
        if (kind === 'meta') return null
        return (
          <div key={index} className={`chg-dl ${kind}`}>
            {line}
          </div>
        )
      })}
    </div>
  )
}

export function ChangesCard({
  api,
  sessionId,
  turn,
}: {
  api: GatewayApi
  sessionId: string | undefined
  /** turn 状态（idle/running）：边沿翻转即刷新（turn 结束的改动由此带回）。 */
  turn: string
}) {
  const [rows, setRows] = useState<ChangeRow[]>()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [openPath, setOpenPath] = useState<string>()
  const [diffs, setDiffs] = useState<Record<string, ChangeDiff | undefined>>({})
  const [undoOpen, setUndoOpen] = useState(false)
  const [undoPreview, setUndoPreview] = useState<UndoPreview>()
  const [undoing, setUndoing] = useState(false)

  const reload = useCallback(() => {
    if (sessionId === undefined) {
      setRows(undefined)
      return
    }
    // 撤销/编辑后统计与行内 diff 都可能变：diff 缓存一并失效，展开行重拉。
    setDiffs({})
    void api
      .changes()
      .then((snapshot) => setRows(snapshot.paths))
      .catch(() => {})
  }, [api, sessionId])

  // 会话切换重置 + turn 边沿刷新。
  useEffect(() => {
    setOpenPath(undefined)
    reload()
  }, [reload, turn])

  // 行内展开时按需拉 diff（缓存未命中才发请求）。
  useEffect(() => {
    if (openPath === undefined || openPath in diffs) return
    void api
      .changesDiff(openPath)
      .then((diff) => setDiffs((current) => ({ ...current, [openPath]: diff })))
      .catch(() => {})
  }, [api, openPath, diffs])

  const toggleExpanded = () => {
    if (!expanded) reload()
    setExpanded((value) => !value)
  }

  const openUndo = useCallback(async () => {
    setUndoPreview(await api.changesUndoPreview().catch(() => undefined))
    setUndoOpen(true)
  }, [api])

  const runUndo = useCallback(async () => {
    setUndoing(true)
    try {
      await api.changesUndo()
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
        <span className="chg-card-title">{t('changes.title', { count: rows.length })}</span>
        <span className="chg-stat add">+{totals.added}</span>
        <span className="chg-stat del">−{totals.removed}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="small"
          type="text"
          disabled={pending.length === 0}
          onClick={(event) => {
            event.stopPropagation()
            void openUndo()
          }}
        >
          {t('changes.undo')}
        </Button>
      </div>
      {expanded &&
        rows.map((row) => {
          const name = row.path.split('/').pop() ?? row.path
          const dir = row.path.slice(0, row.path.length - name.length)
          const open = openPath === row.path
          return (
            <div key={row.path} className="chg-card-row-wrap">
              <div
                className="chg-card-row"
                onClick={() => setOpenPath(open ? undefined : row.path)}
              >
                <FileOutlined className="chg-card-icon" />
                <span className="chg-card-name">{name}</span>
                <span className="chg-card-dir">{dir}</span>
                {row.stats && !row.stats.truncated && (
                  <>
                    <span className="chg-stat add">+{row.stats.linesAdded}</span>
                    <span className="chg-stat del">−{row.stats.linesRemoved}</span>
                  </>
                )}
                {row.allConsumed && (
                  <span className="chg-card-consumed">{t('changes.undone')}</span>
                )}
                {open ? <DownOutlined /> : <RightOutlined />}
              </div>
              {open && <RowDiff diff={diffs[row.path]} />}
            </div>
          )
        })}

      <Modal
        open={undoOpen}
        title={t('changes.undoTitle')}
        okText={t('changes.undoConfirm')}
        okButtonProps={{ danger: true, disabled: !undoPreview?.undoable, loading: undoing }}
        cancelText={t('common.cancel')}
        onOk={() => void runUndo()}
        onCancel={() => setUndoOpen(false)}
      >
        {undoPreview === undefined ? (
          <span>{t('common.loading')}</span>
        ) : undoPreview.undoable ? (
          <>
            <span>
              {t('changes.undoPreviewPrefix')}
              <strong>{undoPreview.paths.length}</strong>
              {t('changes.undoPreviewSuffix')}
            </span>
            {undoPreview.paths.map((path) => (
              <div key={path} className="chg-undo-path">
                {path}
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
                    ? t('changes.warnModified', { path: warning.path })
                    : t('changes.warnMissing', { path: warning.path })
                }
              />
            ))}
          </>
        ) : (
          <span>{t('changes.noUndoable')}</span>
        )}
      </Modal>
    </div>
  )
}
