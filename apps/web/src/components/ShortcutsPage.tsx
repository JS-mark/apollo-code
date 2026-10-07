'use client'

import { Table, Typography } from 'antd'

import { useI18n } from '../lib/i18n'

/** 快捷键页（W-16）：只列 Web 端真实存在的键位，不放占位。 */
export function ShortcutsPage() {
  const { t } = useI18n()
  const rows = [
    { key: '1', keys: 'Enter', action: t('shell.scSend') },
    { key: '2', keys: 'Shift + Enter', action: t('shell.scNewline') },
    { key: '3', keys: 'Cmd/Ctrl + V', action: t('shell.scPasteImage') },
    { key: '4', keys: t('shell.scDragKeys'), action: t('shell.scAddImage') },
    { key: '5', keys: 'Esc', action: t('shell.scCloseMenus') },
    { key: '6', keys: t('shell.scPaletteKeys'), action: t('shell.scCommandPalette') },
    { key: '7', keys: 'Cmd + J', action: t('shell.scFocusTerminal') },
    { key: '8', keys: 'Cmd + B', action: t('shell.actionToggleSidebar') },
    { key: '9', keys: 'Cmd + ,', action: t('shell.scOpenSettings') },
  ]
  return (
    <section style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {t('shell.route.shortcuts')}
      </Typography.Title>
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        columns={[
          {
            dataIndex: 'keys',
            key: 'keys',
            width: 220,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
          },
          { dataIndex: 'action', key: 'action' },
        ]}
      />
    </section>
  )
}
