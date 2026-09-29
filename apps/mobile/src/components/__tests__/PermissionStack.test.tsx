import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { PermissionCard } from '../../lib/chat'
import { PermissionStack } from '../PermissionStack'

const card = (overrides: Partial<PermissionCard> = {}): PermissionCard => ({
  id: 'p-1',
  attempt: 1,
  display: { approvable: true, spec: '{"fs":{"write":["/tmp/a.ts"]}}', toolName: 'Write' },
  ...overrides,
})

describe('PermissionStack（移动端审批卡：一键决策面）', () => {
  it('单请求：渲染工具名 + 结构化能力行（不是裸 JSON）', () => {
    const html = renderToStaticMarkup(
      <PermissionStack permissions={[card()]} onDecide={() => {}} />,
    )
    expect(html).toContain('Write')
    expect(html).toContain('写入')
    expect(html).toContain('/tmp/a.ts')
    expect(html).toContain('权限请求')
  })

  it('审批倒计时：带 expiresAt 渲染剩余秒数/过期过渡文案，缺省不渲染', () => {
    const future = renderToStaticMarkup(
      <PermissionStack
        permissions={[card({ expiresAt: Date.now() + 60_000 })]}
        onDecide={() => {}}
      />,
    )
    expect(future).toContain('perm-countdown')
    expect(future).toMatch(/\d+s 后自动拒绝/)
    const expired = renderToStaticMarkup(
      <PermissionStack permissions={[card({ expiresAt: Date.now() - 1 })]} onDecide={() => {}} />,
    )
    expect(expired).toContain('自动拒绝中…')
    const undated = renderToStaticMarkup(
      <PermissionStack permissions={[card()]} onDecide={() => {}} />,
    )
    expect(undated).not.toContain('perm-countdown')
  })

  it('七档决策面：全部档位都是一键按钮（无「先选档再批准」段控件）', () => {
    const html = renderToStaticMarkup(
      <PermissionStack permissions={[card()]} onDecide={() => {}} />,
    )
    for (const kind of [
      'allow-once',
      'allow-session',
      'allow-project',
      'allow-forever',
      'allow-all-session',
      'deny',
      'deny-forever',
    ])
      expect(html).toContain(`data-kind="${kind}"`)
    // 旧两段式（作用域段控件 + 复合批准键）已移除
    expect(html).not.toContain('data-scope=')
    expect(html).not.toContain('批准 ·')
  })

  it('完整 JSON 收进「详情」折叠（能力行直读，不再有 能力/数据 tab）', () => {
    const html = renderToStaticMarkup(
      <PermissionStack permissions={[card()]} onDecide={() => {}} />,
    )
    expect(html).toContain('perm-details')
    expect(html).toContain('详情')
    expect(html).not.toContain('data-view-tab=')
  })

  it('多请求：tab 条渲染每个请求，计数提示 N/M', () => {
    const html = renderToStaticMarkup(
      <PermissionStack
        permissions={[
          card(),
          card({ id: 'p-2', display: { approvable: true, spec: '{}', toolName: 'Bash' } }),
        ]}
        onDecide={() => {}}
      />,
    )
    expect(html).toContain('1/2')
    expect(html).toContain('data-request-tab="Write"')
    expect(html).toContain('data-request-tab="Bash"')
  })

  it('不可审批（approvable=false）：无放行档位，仅拒绝/永不', () => {
    const html = renderToStaticMarkup(
      <PermissionStack
        permissions={[
          card({
            display: {
              approvable: false,
              spec: '[permission details unavailable - deny only]',
              toolName: 'Write',
            },
          }),
        ]}
        onDecide={() => {}}
      />,
    )
    expect(html).not.toContain('data-kind="allow')
    expect(html).toContain('data-kind="deny"')
    expect(html).toContain('data-kind="deny-forever"')
    expect(html).toContain('fail closed')
  })

  it('解析失败的 spec 回退原文展示（不猜测），且无详情折叠', () => {
    const html = renderToStaticMarkup(
      <PermissionStack
        permissions={[card({ display: { approvable: true, spec: '{oops', toolName: 'Write' } })]}
        onDecide={() => {}}
      />,
    )
    expect(html).toContain('{oops')
    expect(html).not.toContain('perm-details')
  })

  it('子代理 lineage 徽标透传（§2.7bis.5 U4）', () => {
    const html = renderToStaticMarkup(
      <PermissionStack
        permissions={[card({ lineage: { sessionId: 's', agentType: 'explore' } })]}
        onDecide={() => {}}
      />,
    )
    expect(html).toContain('子代理 · explore')
  })

  it('空队列不渲染', () => {
    const html = renderToStaticMarkup(<PermissionStack permissions={[]} onDecide={() => {}} />)
    expect(html).toBe('')
  })
})
