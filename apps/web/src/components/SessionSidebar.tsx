'use client'

/**
 * 侧栏：搜索 + 会话分组列表。
 * - 「+」下拉：新建对话 / 新建分组（capability 未接线时只有新建对话）；
 * - 有用户分组时按分组展示（用户分组按创建序，未分组殿后），分组可折叠；
 * - 每个分组默认展示 5 条，「更多」每次再加载 5 条；
 * - 会话条目 ⋯ 菜单可复制会话 ID（连同设备 ID，便于用户反馈问题时自助取证）、
 *   把会话移动到其他分组、删除会话（确认弹窗；能力位未接线时隐藏）；
 * - 无用户分组时退化为平铺全量列表（不截断历史）；搜索时平铺展示匹配项。
 */
import {
  CommentOutlined,
  DownOutlined,
  EllipsisOutlined,
  FolderAddOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { InputRef } from 'antd'
import { App, Button, Dropdown, Empty, Input, Modal, Typography } from 'antd'
import { useMemo, useState } from 'react'

import type { SessionGroup, SessionGroupsView, SessionSummary, WebApi } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { SidebarGroup } from '../lib/session-groups'
import { buildSidebarGroups, nextVisibleCount, visibleCount } from '../lib/session-groups'

interface SessionSidebarProps {
  api: WebApi
  sessions: readonly SessionSummary[]
  groups: SessionGroupsView
  /** bootstrap capability.sessionGroups：未接线时隐藏分组入口、平铺展示。 */
  groupingEnabled: boolean
  /** bootstrap capability.mutations.sessionDelete：未接线时隐藏删除入口。 */
  deleteEnabled: boolean
  /** bootstrap server.serverId：「复制会话 ID」一并带出，供排障对账。 */
  serverId: string
  activeId: string | undefined
  /** 「最近会话」弹层的管理入口聚焦此搜索框。 */
  searchRef?: React.Ref<InputRef>
  onSelect(id: string): void
  onNewChat(): void
  onGroupsChanged(): void
  /** 会话删除成功后回调（AppShell 负责刷新清单与活动会话复位；next = 宿主冷启动的新会话）。 */
  onSessionDeleted(id: string, next: string | undefined): void
}

/** 会话条目的时间副标：HH:MM。 */
function timeLabel(updatedAt: string): string {
  const time = Date.parse(updatedAt)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

type NameModal = { mode: 'create' } | { mode: 'rename'; group: SessionGroup } | null

export function SessionSidebar(props: SessionSidebarProps) {
  const { api, groupingEnabled, deleteEnabled, serverId, groups, sessions, activeId } = props
  const { message } = App.useApp()
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({})
  const [nameModal, setNameModal] = useState<NameModal>(null)
  const [nameValue, setNameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionGroup | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<SessionSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const searching = query.trim().length > 0
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sessions
    return sessions.filter(
      (session) => session.title.toLowerCase().includes(needle) || session.id.includes(needle),
    )
  }, [sessions, query])

  const sidebarGroups = useMemo(() => buildSidebarGroups(filtered, groups), [filtered, groups])
  // 平铺模式：搜索中 / 分组能力未接线 / 还没有任何用户分组（不截断历史）。
  const flat = searching || !groupingEnabled || groups.groups.length === 0

  const groupOf = (sessionId: string): string | null => groups.assignments[sessionId] ?? null

  const runOp = async (op: () => Promise<unknown>, success: string) => {
    try {
      await op()
      message.success(success)
      props.onGroupsChanged()
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const submitNameModal = async () => {
    if (!nameModal) return
    const name = nameValue.trim()
    if (!name) return
    if (nameModal.mode === 'create')
      await runOp(() => api.createSessionGroup(name), t('shell.groupCreated'))
    else
      await runOp(() => api.renameSessionGroup(nameModal.group.id, name), t('shell.groupRenamed'))
    setNameModal(null)
  }

  const submitDeleteSession = async () => {
    const target = deleteSessionTarget
    if (!target || deleting) return
    setDeleting(true)
    try {
      const result = await api.deleteSession(target.id)
      message.success(t('shell.sessionDeleted'))
      setDeleteSessionTarget(null)
      props.onSessionDeleted(target.id, result.next)
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  /** 会话条目 ⋯ 菜单：复制会话 ID + 移动到分组（分组能力开启时）+ 删除会话（删除能力开启时）。 */
  const sessionMenu = (session: SessionSummary): MenuProps | undefined => {
    const items: MenuProps['items'] = [
      { key: 'copy-id', label: t('shell.copySessionId') },
      ...(groupingEnabled
        ? [
            {
              key: 'move',
              label: t('shell.moveToGroup'),
              children: [
                {
                  key: 'move:',
                  label: t('shell.ungrouped'),
                  disabled: groupOf(session.id) === null,
                },
                ...groups.groups.map((group) => ({
                  key: `move:${group.id}`,
                  label: group.name,
                  disabled: groupOf(session.id) === group.id,
                })),
              ],
            },
          ]
        : []),
      ...(deleteEnabled ? [{ key: 'delete', label: t('shell.deleteSession'), danger: true }] : []),
    ]
    if (items.length === 0) return undefined
    return {
      items,
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation()
        if (key === 'delete') {
          setDeleteSessionTarget(session)
          return
        }
        if (key === 'copy-id') {
          // 排障取证：设备 ID（服务器实例）+ 会话 ID 一次带全，用户直接粘贴反馈。
          void navigator.clipboard
            .writeText(t('shell.copyIdsText', { deviceId: serverId, sessionId: session.id }))
            .then(() => message.success(t('shell.copied')))
            .catch((cause: unknown) =>
              message.error(cause instanceof Error ? cause.message : String(cause)),
            )
          return
        }
        if (!key.startsWith('move:')) return
        const groupId = key.slice('move:'.length) || null
        void runOp(
          () => api.assignSessionGroup(session.id, groupId),
          groupId ? t('shell.sessionMoved') : t('shell.sessionMovedToUngrouped'),
        )
      },
    }
  }

  const renderItem = (session: SessionSummary) => {
    const menu = sessionMenu(session)
    return (
      <div
        key={session.id}
        className={session.id === activeId ? 'sg-item sg-item-active' : 'sg-item'}
        onClick={() => props.onSelect(session.id)}
      >
        <div className="sg-avatar">V</div>
        <div className="sg-item-text">
          <Typography.Text strong ellipsis style={{ display: 'block' }}>
            {session.title}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {timeLabel(session.updatedAt)} · {session.cwd.split('/').pop() ?? session.cwd}
          </Typography.Text>
        </div>
        {menu && (
          <Dropdown trigger={['click']} placement="bottomRight" menu={menu}>
            <Button
              className="sg-item-menu"
              type="text"
              size="small"
              icon={<EllipsisOutlined />}
              onClick={(event) => event.stopPropagation()}
            />
          </Dropdown>
        )}
      </div>
    )
  }

  const renderGroup = (group: SidebarGroup) => {
    const isCollapsed = collapsed[group.key] === true
    const visible = visibleCount(visibleCounts[group.key], group.sessions.length)
    const remaining = group.sessions.length - visible
    // 内置「未分组」无管理菜单；用户分组从 view 里取回实体做重命名/删除。
    const source = group.builtin ? undefined : groups.groups.find((g) => g.id === group.key)
    const menu: MenuProps | undefined = source
      ? {
          items: [
            { key: 'rename', label: t('shell.renameGroup') },
            { key: 'delete', label: t('shell.deleteGroup'), danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation()
            if (key === 'rename') {
              setNameValue(source.name)
              setNameModal({ mode: 'rename', group: source })
            } else if (key === 'delete') {
              setDeleteTarget(source)
            }
          },
        }
      : undefined
    return (
      <div className="sg-group" key={group.key}>
        <div
          className="sg-group-header"
          onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))}
        >
          {isCollapsed ? (
            <RightOutlined className="sg-caret" />
          ) : (
            <DownOutlined className="sg-caret" />
          )}
          <span className="sg-group-name">{group.name}</span>
          <span className="sg-group-count">{group.sessions.length}</span>
          {menu && (
            <Dropdown trigger={['click']} placement="bottomRight" menu={menu}>
              <Button
                className="sg-item-menu"
                type="text"
                size="small"
                icon={<EllipsisOutlined />}
                onClick={(event) => event.stopPropagation()}
              />
            </Dropdown>
          )}
        </div>
        {!isCollapsed &&
          (group.sessions.length === 0 ? (
            <div className="sg-group-empty">{t('shell.groupEmpty')}</div>
          ) : (
            <>
              {group.sessions.slice(0, visible).map(renderItem)}
              {remaining > 0 && (
                <Button
                  type="link"
                  size="small"
                  className="sg-more"
                  onClick={() =>
                    setVisibleCounts((current) => ({
                      ...current,
                      [group.key]: nextVisibleCount(current[group.key], group.sessions.length),
                    }))
                  }
                >
                  {t('shell.moreSessions', { count: remaining })}
                </Button>
              )}
            </>
          ))}
      </div>
    )
  }

  const showEmpty =
    filtered.length === 0 && sidebarGroups.every((group) => group.sessions.length === 0)

  return (
    <>
      <div style={{ display: 'flex', gap: 8, padding: '10px 10px 6px' }}>
        <Input
          ref={props.searchRef}
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t('shell.searchSessions')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              { key: 'chat', label: t('shell.newChat'), icon: <CommentOutlined /> },
              ...(groupingEnabled
                ? [{ key: 'group', label: t('shell.newGroup'), icon: <FolderAddOutlined /> }]
                : []),
            ],
            onClick: ({ key }) => {
              if (key === 'chat') props.onNewChat()
              else if (key === 'group') {
                setNameValue('')
                setNameModal({ mode: 'create' })
              }
            },
          }}
        >
          <Button icon={<PlusOutlined />} title={t('shell.newChatOrGroup')} />
        </Dropdown>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}>
        {showEmpty ? (
          <Empty
            description={searching ? t('shell.noMatchingSessions') : t('shell.noSessions')}
            style={{ marginTop: 32 }}
          />
        ) : flat ? (
          filtered.map(renderItem)
        ) : (
          sidebarGroups.map(renderGroup)
        )}
      </div>
      <Modal
        title={nameModal?.mode === 'rename' ? t('shell.renameGroup') : t('shell.newGroup')}
        open={nameModal !== null}
        okText={nameModal?.mode === 'rename' ? t('shell.save') : t('shell.create')}
        cancelText={t('shell.cancel')}
        okButtonProps={{ disabled: !nameValue.trim() }}
        onCancel={() => setNameModal(null)}
        onOk={() => void submitNameModal()}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder={t('shell.groupNamePlaceholder')}
          value={nameValue}
          maxLength={60}
          onChange={(event) => setNameValue(event.target.value)}
          onPressEnter={(event) => {
            event.preventDefault()
            void submitNameModal()
          }}
        />
      </Modal>
      <Modal
        title={t('shell.deleteGroup')}
        open={deleteTarget !== null}
        okText={t('shell.delete')}
        okButtonProps={{ danger: true }}
        cancelText={t('shell.cancel')}
        onCancel={() => setDeleteTarget(null)}
        onOk={() => {
          if (!deleteTarget) return
          void (async () => {
            await runOp(() => api.deleteSessionGroup(deleteTarget.id), t('shell.groupDeleted'))
            setDeleteTarget(null)
          })()
        }}
      >
        {deleteTarget && (
          <Typography.Text>
            {t('shell.deleteGroupConfirm', { name: deleteTarget.name })}
          </Typography.Text>
        )}
      </Modal>
      <Modal
        title={t('shell.deleteSession')}
        open={deleteSessionTarget !== null}
        okText={t('shell.delete')}
        okButtonProps={{ danger: true, loading: deleting }}
        cancelText={t('shell.cancel')}
        onCancel={() => {
          if (deleting) return
          setDeleteSessionTarget(null)
        }}
        onOk={() => void submitDeleteSession()}
      >
        {deleteSessionTarget && (
          <Typography.Text>
            {t('shell.deleteSessionConfirm', { title: deleteSessionTarget.title })}
          </Typography.Text>
        )}
      </Modal>
    </>
  )
}
