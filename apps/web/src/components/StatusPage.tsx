'use client'

import { Empty, Table, Typography } from 'antd'

import type { StatusView } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** 状态页：状态端口的只读表格投影。 */
export function StatusPage({ status }: { status: StatusView | undefined }) {
  const { t } = useI18n()
  const rows = (status?.status ?? []).map((row, index) => ({ key: index, ...row }))
  return (
    <section className="page" style={{ padding: 24, overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        {t('manage.status')}
      </Typography.Title>
      {rows.length === 0 ? (
        <Empty description={t('manage.statusUnavailable')} />
      ) : (
        <Table
          size="small"
          showHeader={false}
          pagination={false}
          dataSource={rows}
          columns={[
            {
              dataIndex: 'label',
              key: 'label',
              width: 180,
              render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text>,
            },
            { dataIndex: 'value', key: 'value' },
          ]}
        />
      )}
    </section>
  )
}
