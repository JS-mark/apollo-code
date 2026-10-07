'use client'

/**
 * ⌘K 动作面板（W-16 缩水收口）：全站路由/工作台动作的键盘可达入口。
 * 纯本地 UI（无服务端交互）；antd Modal + 自渲染过滤列表，零新依赖。
 */
import { Input, Modal, Typography } from 'antd'
import type { InputRef } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '../lib/i18n'

export interface CommandAction {
  key: string
  label: string
  hint?: string
  run(): void
}

export function CommandModal({
  open,
  onClose,
  actions,
}: {
  open: boolean
  onClose(): void
  actions: readonly CommandAction[]
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<InputRef>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(q) || (action.hint?.toLowerCase().includes(q) ?? false),
    )
  }, [actions, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // 等 Modal 挂载后聚焦（antd Modal 有过渡帧）。
      setTimeout(() => inputRef.current?.focus({ cursor: 'end' }), 50)
    }
  }, [open])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const action = filtered[active]
      if (action) {
        onClose()
        action.run()
      }
    }
  }

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      styles={{ body: { padding: '8px 12px 12px' } }}
    >
      <Input
        ref={inputRef}
        value={query}
        placeholder={t('shell.commandPalettePlaceholder')}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        allowClear
      />
      <div
        style={{ marginTop: 8, display: 'grid', gap: 2 }}
        role="listbox"
        aria-label={t('shell.commandPaletteAria')}
      >
        {filtered.length === 0 && (
          <Typography.Text type="secondary" style={{ padding: '12px 4px' }}>
            {t('shell.commandPaletteNoMatches')}
          </Typography.Text>
        )}
        {filtered.map((action, index) => (
          <button
            key={action.key}
            type="button"
            role="option"
            aria-selected={index === active}
            className={`command-item${index === active ? ' active' : ''}`}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              border: 'none',
              background: index === active ? 'var(--ant-color-bg-text-hover, #f5f5f5)' : 'none',
              borderRadius: 6,
              padding: '8px 10px',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 13,
            }}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              onClose()
              action.run()
            }}
          >
            <span>{action.label}</span>
            {action.hint && (
              <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                {action.hint}
              </Typography.Text>
            )}
          </button>
        ))}
      </div>
    </Modal>
  )
}
