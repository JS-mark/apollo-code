'use client'

import { HistoryOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { Alert, Button, Empty, Modal, Tag, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'
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
  const { t } = useI18n()

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
          {t('chat.changesTitle', {
            count: changes !== undefined && changes.length > 0 ? ` · ${changes.length}` : '',
          })}
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Tooltip title={t('chat.undoLastBatch')}>
          <Button
            size="small"
            type="text"
            icon={<HistoryOutlined />}
            aria-label={t('chat.undoLastBatch')}
            disabled={changes === undefined || changes.length === 0}
            onClick={() => void openUndo()}
          />
        </Tooltip>
        <Tooltip title={t('chat.refresh')}>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            aria-label={t('chat.refresh')}
            onClick={reload}
          />
        </Tooltip>
      </div>

      <div className="chg-list">
        {changes === undefined || changes.length === 0 ? (
          <Empty
            description={
              sessionId === undefined ? t('chat.slashNoSession') : t('chat.noSessionChanges')
            }
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
                    {row.created ? t('chat.changeCreated') : t('chat.changeModified')}
                  </Tag>
                  <span className="chg-item-path">{name}</span>
                  {dir !== '' && <span className="chg-item-dir">{dir}</span>}
                  <Tooltip title={row.allConsumed ? t('chat.undone') : t('chat.undoLatestBatch')}>
                    <Button
                      size="small"
                      type="text"
                      danger
                      disabled={row.allConsumed}
                      icon={<UndoOutlined />}
                      className="chg-item-undo"
                      aria-label={t('chat.undoFileBatchAria', { name })}
                      onClick={(event) => {
                        event.stopPropagation()
                        void openFileUndo(row.path)
                      }}
                    />
                  </Tooltip>
                </div>
                <div className="chg-item-sub">
                  {t('chat.batchesLine', {
                    n: row.batches,
                    tail: row.allConsumed ? t('chat.undone') : row.lastModifiedAt,
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="chg-diff">
        {selected === undefined ? (
          <Empty description={t('chat.selectFileForDiff')} style={{ marginTop: 32 }} />
        ) : diffOfSelected === undefined ? (
          <Typography.Text type="secondary" style={{ padding: '8px 12px' }}>
            {t('chat.loadingDiff')}
          </Typography.Text>
        ) : !diffOfSelected.tracked ? (
          <Empty description={t('chat.noBackupForPath')} style={{ marginTop: 32 }} />
        ) : diffOfSelected.truncated ? (
          <Empty description={t('chat.diffTooLarge')} style={{ marginTop: 32 }} />
        ) : diffOfSelected.diff.trim() === '' ? (
          <Empty
            description={
              diffOfSelected.created ? t('chat.diffEmptyCreated') : t('chat.diffEmptyNoDiff')
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
                  diffOfSelected.deleted ? t('chat.diffDeletedFile') : t('chat.diffMissingBaseline')
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
        title={t('chat.undoLastBatch')}
        okText={t('chat.confirmUndo')}
        okButtonProps={{ danger: true, disabled: !undoPreview?.undoable }}
        cancelText={t('chat.cancel')}
        onOk={() => void runUndo()}
        onCancel={() => setModalOpen(false)}
      >
        {undoPreview === undefined ? (
          <Typography.Text type="secondary">{t('chat.loading')}</Typography.Text>
        ) : undoPreview.undoable ? (
          <>
            <Typography.Text>
              {t('chat.undoLastBatchLead')} <strong>{undoPreview.paths.length}</strong>
              {t('chat.undoLastBatchTail')}
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
                    ? t('chat.undoWarnModified', { path: warning.path })
                    : t('chat.undoWarnMissing', { path: warning.path })
                }
              />
            ))}
          </>
        ) : (
          <Typography.Text type="secondary">{t('chat.noUndoableBatch')}</Typography.Text>
        )}
      </Modal>
      <Modal
        open={fileUndoOf !== undefined}
        title={t('chat.undoFileBatchTitle', { path: fileUndoOf ?? '' })}
        okText={t('chat.confirmUndo')}
        okButtonProps={{ danger: true, disabled: !fileUndoPreview?.undoable }}
        cancelText={t('chat.cancel')}
        onOk={() => void runFileUndo()}
        onCancel={() => {
          setFileUndoOf(undefined)
          setFileUndoPreview(undefined)
        }}
      >
        {fileUndoPreview === undefined ? (
          <Typography.Text type="secondary">{t('chat.loading')}</Typography.Text>
        ) : fileUndoPreview.undoable ? (
          <>
            <Typography.Text>
              {t('chat.undoFileBatchLead')} <strong>{fileUndoPreview.paths.length}</strong>
              {t('chat.undoFileBatchTail')}
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
                title={t('chat.undoMultiFileNote')}
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
                    ? t('chat.undoWarnModified', { path: warning.path })
                    : t('chat.undoWarnMissing', { path: warning.path })
                }
              />
            ))}
          </>
        ) : (
          <Typography.Text type="secondary">{t('chat.noUndoableBatch')}</Typography.Text>
        )}
      </Modal>
    </div>
  )
}
