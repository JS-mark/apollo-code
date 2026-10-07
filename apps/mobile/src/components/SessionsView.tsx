'use client'

/**
 * 会话列表：虚拟滚动（react-virtuoso——DOM 行数有界，长清单不卡顿）
 * + 下拉刷新（手势拉动 → 释放触发）+ 首屏骨架
 * + 左滑操作（「复制ID」取证 + 删除，antd-mobile SwipeAction）。
 * 滚动容器由 Virtuoso 托管（scrollerRef 外借给下拉刷新 hook）；骨架/空态走
 * Header/EmptyPlaceholder，scroller 常驻使手势监听只挂一次。
 */
import { MessageOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App, Button, Empty, Skeleton, Tag, Typography } from 'antd'
import { SwipeAction } from 'antd-mobile'
import type { SwipeActionRef } from 'antd-mobile'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'

import type { SessionSummary } from '../lib/gateway'
import { currentLocale, translate, useI18n } from '../lib/i18n'
import { usePullToRefresh } from '../lib/interactions'

function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary
  active: boolean
  onSelect(): void
}) {
  const { t } = useI18n()
  return (
    <div
      className={`session-item${active ? ' active' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
    >
      <MessageOutlined style={{ fontSize: 18, color: '#1677ff', flexShrink: 0 }} />
      <div className="session-item-main">
        <div className="session-item-title">
          {active && (
            <Tag color="blue" style={{ fontSize: 11, lineHeight: '16px', margin: 0 }}>
              {t('sessions.current')}
            </Tag>
          )}
          <span className="session-item-name">{session.title || t('sessions.untitled')}</span>
        </div>
        <Typography.Text type="secondary" className="session-item-sub" ellipsis>
          {session.summary || session.cwd}
        </Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        {timeLabel(session.updatedAt)}
      </Typography.Text>
    </div>
  )
}

function SessionsSkeleton() {
  return (
    <div aria-busy="true" style={{ padding: '4px 10px' }}>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton
          key={index}
          active
          title={{ width: '46%' }}
          paragraph={{ rows: 1, width: '72%' }}
          style={{ padding: '14px 0' }}
        />
      ))}
    </div>
  )
}

/** Virtuoso 内嵌组件的数据面（组件保持模块级稳定引用，动态值经 context 下发）。 */
interface SessionsListContext {
  /** 首屏水合中：Header 渲染骨架，空态占位让位。 */
  showSkeleton: boolean
  onNewChat: () => void
}

function SessionsListHeader({ context }: { context?: SessionsListContext }) {
  return context?.showSkeleton ? <SessionsSkeleton /> : null
}

function SessionsListEmpty({ context }: { context?: SessionsListContext }) {
  const { t } = useI18n()
  if (context?.showSkeleton) return null
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={t('sessions.emptyDescription')}
      style={{ marginTop: 40 }}
    >
      <Button type="primary" icon={<PlusOutlined />} onClick={() => context?.onNewChat()}>
        {t('sessions.newChat')}
      </Button>
    </Empty>
  )
}

/** 底部留白（原 scroller padding-bottom 迁来：绝对定位行不吃容器 padding）。 */
function SessionsListFooter() {
  return <div className="session-list-tail" />
}

const listComponents = {
  Header: SessionsListHeader,
  EmptyPlaceholder: SessionsListEmpty,
  Footer: SessionsListFooter,
}

export function SessionsView({
  sessions,
  loading,
  activeId,
  deviceId,
  onRefresh,
  onResume,
  onNewChat,
  onDelete,
}: {
  sessions: SessionSummary[]
  /** 首次加载（骨架屏）；刷新由下拉手势承担。 */
  loading: boolean
  activeId: string | undefined
  /** 网关签发的设备 ID：「复制ID」与会话 ID 一并带出，供反馈问题对账。 */
  deviceId: string
  onRefresh(): Promise<void> | void
  onResume(id: string): void
  onNewChat(): void
  /** 确认后执行删除（page 层负责 API 调用、清单刷新与会话复位）。 */
  onDelete(id: string): Promise<void> | void
}) {
  const { modal, message } = App.useApp()
  const { t } = useI18n()
  const scrollRef = useRef<HTMLElement | null>(null)
  /** 当前左滑展开的会话 id（同时只展开一行；SwipeAction 实例按 id 收拢关闭）。 */
  const [swipedId, setSwipedId] = useState<string>()
  const swipeRefs = useRef(new Map<string, SwipeActionRef>())
  const swipeRefCallbacks = useRef(new Map<string, (ref: SwipeActionRef | null) => void>())
  /** ref 置 null 的去抖定时器（见 swipeRefFor 注释）。 */
  const detachTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // 行级 ref 回调按 id 缓存成稳定实例，且 null 分支去抖后才清 swipedId：
  // antd-mobile 的 useImperativeHandle 未给 deps，每次 commit 都会把 callback ref
  // 先置 null 再重挂同一实例；若 null 分支立即清归属，单开 effect 会把刚展开的
  // 行当场收起——表现为「左滑松手根本停不住」（展开动作自身的重渲染即可复现）。
  const swipeRefFor = (id: string): ((ref: SwipeActionRef | null) => void) => {
    let callback = swipeRefCallbacks.current.get(id)
    if (!callback) {
      callback = (ref) => {
        if (ref) {
          swipeRefs.current.set(id, ref)
          const timer = detachTimers.current.get(id)
          if (timer !== undefined) {
            clearTimeout(timer)
            detachTimers.current.delete(id)
          }
          return
        }
        swipeRefs.current.delete(id)
        detachTimers.current.set(
          id,
          setTimeout(() => {
            detachTimers.current.delete(id)
            // 等不到重挂 = 真卸载（虚拟化回收：展开中的行滚出视口即卸载），
            // 此时才清归属，否则滚回来后首击被当成「收起」吞掉。
            setSwipedId((current) => (current === id ? undefined : current))
          }, 0),
        )
      }
      swipeRefCallbacks.current.set(id, callback)
    }
    return callback
  }
  const { pull, refreshing, armed, trigger } = usePullToRefresh(scrollRef, onRefresh)

  // 单开协调：任一行展开时收起其他行（onClose 只清自己的归属，避免互踩）。
  useEffect(() => {
    for (const [id, ref] of swipeRefs.current) if (id !== swipedId) ref.close()
  }, [swipedId])

  const confirmDelete = useCallback(
    (session: SessionSummary) => {
      modal.confirm({
        title: t('sessions.deleteTitle'),
        content: t('sessions.deleteConfirm', { name: session.title || t('sessions.untitled') }),
        okText: t('common.delete'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: () => onDelete(session.id),
      })
    },
    [modal, onDelete, t],
  )

  /** 左滑「复制ID」：设备 ID + 会话 ID 一次带全，用户直接粘贴给维护者取证。 */
  const copySessionId = useCallback(
    (session: SessionSummary) => {
      void navigator.clipboard
        .writeText(
          translate(currentLocale(), 'sessions.copyIdPayload', {
            device: deviceId,
            session: session.id,
          }),
        )
        .then(() => message.success(t('common.copied')))
        .catch(() => message.error(t('sessions.copyFailed')))
    },
    [deviceId, message, t],
  )

  const renderRow = (session: SessionSummary) => (
    <div className="session-item-wrap" key={session.id}>
      <div className="swipe-item">
        <SwipeAction
          ref={swipeRefFor(session.id)}
          closeOnAction
          closeOnTouchOutside={false}
          rightActions={[
            {
              key: 'copy',
              text: t('sessions.copyId'),
              color: 'primary',
              onClick: () => copySessionId(session),
            },
            {
              key: 'delete',
              text: t('common.delete'),
              color: 'danger',
              onClick: () => confirmDelete(session),
            },
          ]}
          onActionsReveal={(side) => {
            if (side === 'right') setSwipedId(session.id)
          }}
          onClose={() => setSwipedId((current) => (current === session.id ? undefined : current))}
        >
          <SessionRow
            session={session}
            active={session.id === activeId}
            onSelect={() => {
              // 展开状态先收起，不当作「选择会话」。
              if (swipedId === session.id) {
                swipeRefs.current.get(session.id)?.close()
                return
              }
              onResume(session.id)
            }}
          />
        </SwipeAction>
      </div>
    </div>
  )

  return (
    <div className="sessions-wrap">
      <div
        className="pull-indicator"
        data-state={refreshing ? 'refreshing' : armed ? 'armed' : pull > 0 ? 'pulling' : 'idle'}
      >
        <span className="pull-spinner">{refreshing ? '⏳' : armed ? '↑' : '↓'}</span>
        <span>
          {refreshing
            ? t('sessions.refreshing')
            : armed
              ? t('sessions.releaseToRefresh')
              : pull > 0
                ? t('sessions.pullToRefresh')
                : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '4px 10px 10px' }}>
        <Button block icon={<PlusOutlined />} onClick={onNewChat}>
          {t('sessions.newSession')}
        </Button>
        {/* 手动刷新与下拉手势走同一 trigger：refreshing/loading 状态同源，快网下也有最短反馈。 */}
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void trigger()} />
      </div>
      <Virtuoso
        className="session-scroll"
        data={sessions}
        computeItemKey={(_, session) => session.id}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        scrollerRef={(el) => {
          scrollRef.current = el instanceof HTMLElement ? el : null
        }}
        context={{ showSkeleton: loading && sessions.length === 0, onNewChat }}
        components={listComponents}
        itemContent={(_, session) => renderRow(session)}
      />
    </div>
  )
}
