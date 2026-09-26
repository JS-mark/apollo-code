'use client'

import { HistoryOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Modal, Tag, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { WebApi } from '../lib/api'
import { DiffView } from './DiffView'

interface ChangeRow {
  path: string
  created: boolean
  batches: number
  lastModifiedAt: string
  allConsumed: boolean
}

interface UndoPreview {
  undoable: boolean
  reason?: string
  paths: string[]
  warnings: { path: string; kind: string }[]
  stepCreatedAt?: string
}

interface ChangeDiff {
  path: string
  tracked: boolean
  created: boolean
  beforeAvailable: boolean
  deleted: boolean
  truncated?: boolean
  diff: string
  linesAdded: number
  linesRemoved: number
}

const POLL_MS = 3000

/**
 * 会话文件变更面板（§22 W-08）：工作台「文件变更」标签页的内容——变更列表 +
 * 选中文件的 inline diff + undo。数据每 POLL_MS 轮询一次，turn 结束的改动由
 * 下一轮轮询自然带回，无需上游透传流状态。
 */
export function ChangesPane({
  api,
  sessionId,
  focus,
}: {
  api: WebApi
  sessionId: string | undefined
  /** 「审查」定位信号：seq 变化即选中 path（列表未加载也能选中——diff 按路径直拉）。 */
  focus?: { seq: number; path: string }
}) {
  const [changes, setChanges] = useState<ChangeRow[]>()
  const [selected, setSelected] = useState<string>()
  const [diff, setDiff] = useState<ChangeDiff>()
  const [modalOpen, setModalOpen] = useState(false)
  const [undoPreview, setUndoPreview] = useState<UndoPreview>()
  const [fileUndoOf, setFileUndoOf] = useState<string>()
  const [fileUndoPreview, setFileUndoPreview] = useState<UndoPreview>()

  const reload = useCallback(() => {
    void api
      .changes()
      .then((snapshot) => setChanges(snapshot.paths))
      .catch(() => setChanges(undefined))
  }, [api])

  // 列表轮询 + 会话切换重置（选中文件跨会话无意义）。
  useEffect(() => {
    setSelected(undefined)
    setDiff(undefined)
    if (sessionId === undefined) {
      setChanges(undefined)
      return
    }
    reload()
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [api, sessionId, reload])

  // 「审查」定位：选中目标文件（列表行有无该路径都直拉 diff）。
  useEffect(() => {
    if (!focus || focus.seq <= 0 || !focus.path) return
    setSelected(focus.path)
  }, [focus])

  // 选中文件 + 行签名（批次/时间/是否已撤销）变化才重拉 diff：轮询不引起无谓
  // 刷新，且重拉不先清内容，避免收帧闪烁。键里带路径——不同文件签名相同时也要重拉。
  const selectedRow = changes?.find((row) => row.path === selected)
  const fetchKey =
    selected === undefined
      ? ''
      : `${selected}\n${selectedRow?.batches}:${selectedRow?.lastModifiedAt}:${selectedRow?.allConsumed}`
  const fetchKeyRef = useRef('')
  useEffect(() => {
    const path = selected
    if (path === undefined || fetchKey === '' || fetchKey === fetchKeyRef.current) return
    fetchKeyRef.current = fetchKey
    void api
      .changesDiff(path)
      .then(setDiff)
      .catch(() => setDiff(undefined))
  }, [api, fetchKey, selected])

  const openUndo = useCallback(async () => {
    setUndoPreview(await api.undoPreview().catch(() => undefined))
    setModalOpen(true)
  }, [api])

  const openFileUndo = useCallback(
    async (path: string) => {
      setFileUndoPreview(await api.changesUndoPreview(path).catch(() => undefined))
      setFileUndoOf(path)
    },
    [api],
  )

  const runUndo = useCallback(async () => {
    try {
      await api.undo()
      setModalOpen(false)
      setUndoPreview(undefined)
      fetchKeyRef.current = ''
      reload()
    } catch {
      // 失败信息经 Modal 关闭即可；错误留在 console
    }
  }, [api, reload])

  const runFileUndo = useCallback(async () => {
    if (fileUndoOf === undefined) return
    try {
      await api.changesUndo(fileUndoOf)
      setFileUndoOf(undefined)
      setFileUndoPreview(undefined)
      fetchKeyRef.current = ''
      reload()
    } catch {
      // 失败信息经 Modal 关闭即可；错误留在 console
    }
  }, [api, fileUndoOf, reload])

  // diff 内容与选中文件对齐前视为加载中（不清旧内容，防止闪烁）。
  const diffOfSelected = selected !== undefined && diff?.path === selected ? diff : undefined

  return (
    <div className="chg-pane">
      <div className="chg-head">
        <Typography.Text strong>
          文件变更{changes !== undefined && changes.length > 0 ? ` · ${changes.length}` : ''}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Tooltip title="撤销上一批变更">
          <Button
            size="small"
            type="text"
            icon={<HistoryOutlined />}
            aria-label="撤销上一批变更"
            disabled={changes === undefined || changes.length === 0}
            onClick={() => void openUndo()}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            aria-label="刷新"
            onClick={reload}
          />
        </Tooltip>
      </div>

      <div className="chg-list">
        {changes === undefined || changes.length === 0 ? (
          <Empty
            description={sessionId === undefined ? '没有活动会话' : '本会话暂无文件变更'}
            style={{ marginTop: 32 }}
          />
        ) : (
          changes.map((row) => {
            const name = row.path.split('/').pop() ?? row.path
            const dir = row.path.slice(0, row.path.length - name.length)
            return (
              <div
                key={row.path}
                className={`chg-item${row.path === selected ? ' active' : ''}`}
                title={row.path}
                onClick={() => setSelected(row.path)}
              >
                <div className="chg-item-line">
                  <Tag color={row.created ? 'success' : 'default'} style={{ marginInlineEnd: 6 }}>
                    {row.created ? '新建' : '修改'}
                  </Tag>
                  <span className="chg-item-path">{name}</span>
                  {dir !== '' && <span className="chg-item-dir">{dir}</span>}
                  <Tooltip title={row.allConsumed ? '已撤销' : '撤销最近批次'}>
                    <Button
                      size="small"
                      type="text"
                      danger
                      disabled={row.allConsumed}
                      icon={<UndoOutlined />}
                      className="chg-item-undo"
                      aria-label={`撤销 ${name} 的最近批次`}
                      onClick={(event) => {
                        event.stopPropagation()
                        void openFileUndo(row.path)
                      }}
                    />
                  </Tooltip>
                </div>
                <div className="chg-item-sub">
                  {row.batches} 批 · {row.allConsumed ? '已撤销' : row.lastModifiedAt}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="chg-diff">
        {selected === undefined ? (
          <Empty description="选择文件查看 diff" style={{ marginTop: 32 }} />
        ) : diffOfSelected === undefined ? (
          <Typography.Text type="secondary" style={{ padding: '8px 12px' }}>
            加载 diff…
          </Typography.Text>
        ) : !diffOfSelected.tracked ? (
          <Empty description="该路径没有本会话的备份记录" style={{ marginTop: 32 }} />
        ) : diffOfSelected.truncated ? (
          <Empty
            description="文件过大，净效果 diff 不做全量渲染（可直接撤销批次）"
            style={{ marginTop: 32 }}
          />
        ) : diffOfSelected.diff.trim() === '' ? (
          <Empty
            description={
              diffOfSelected.created
                ? '会话新建的文件（当前无净变化）'
                : '与备份起点无差异（可能已撤销）'
            }
            style={{ marginTop: 32 }}
          />
        ) : (
          <>
            <div className="chg-diff-head">
              <Typography.Text code style={{ fontSize: 11 }} ellipsis>
                {selected}
              </Typography.Text>
              <span className="chg-diff-stat add">+{diffOfSelected.linesAdded}</span>
              <span className="chg-diff-stat del">−{diffOfSelected.linesRemoved}</span>
            </div>
            {!diffOfSelected.beforeAvailable || diffOfSelected.deleted ? (
              <Alert
                type="warning"
                showIcon
                style={{ margin: '0 8px 8px' }}
                title={
                  diffOfSelected.deleted
                    ? '文件已在本会话内删除'
                    : '备份起点快照缺失，diff 从空文件起算'
                }
              />
            ) : null}
            <div className="chg-diff-body">
              <DiffView diff={diffOfSelected.diff} />
            </div>
          </>
        )}
      </div>

      <Modal
        open={modalOpen}
        title="撤销上一批变更"
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !undoPreview?.undoable }}
        cancelText="取消"
        onOk={() => void runUndo()}
        onCancel={() => setModalOpen(false)}
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
      <Modal
        open={fileUndoOf !== undefined}
        title={`撤销 ${fileUndoOf ?? ''} 的最近批次`}
        okText="确认撤销"
        okButtonProps={{ danger: true, disabled: !fileUndoPreview?.undoable }}
        cancelText="取消"
        onOk={() => void runFileUndo()}
        onCancel={() => {
          setFileUndoOf(undefined)
          setFileUndoPreview(undefined)
        }}
      >
        {fileUndoPreview === undefined ? (
          <Typography.Text type="secondary">加载中…</Typography.Text>
        ) : fileUndoPreview.undoable ? (
          <>
            <Typography.Text>
              将撤销以下 <strong>{fileUndoPreview.paths.length}</strong> 个文件的最近批次：
            </Typography.Text>
            {fileUndoPreview.paths.map((path) => (
              <div key={path} style={{ padding: '2px 0' }}>
                <Typography.Text type="secondary">{path}</Typography.Text>
              </div>
            ))}
            {fileUndoPreview.paths.length > 1 ? (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 8 }}
                title="该批次是一次工具调用产生的多个文件，将一并撤销。"
              />
            ) : null}
            {fileUndoPreview.warnings.map((warning) => (
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
