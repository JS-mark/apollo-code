import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SubagentRunRow } from '../../lib/gateway'
import { SubagentsRow } from '../SubagentsRow'

const run = (
  overrides: Partial<Omit<SubagentRunRow, 'agentType'>> &
    Partial<Pick<SubagentRunRow, 'agentType'>> = {},
): SubagentRunRow => ({
  sessionId: 'sub-1',
  depth: 1,
  status: 'running',
  startedAt: Date.now() - 65_000,
  promptPreview: 'scan the repo',
  prompt: 'scan the repo',
  ...overrides,
})

describe('SubagentsRow（移动端只读运行行）', () => {
  it('无运行：不渲染任何行', () => {
    const html = renderToStaticMarkup(
      <SubagentsRow gateway={undefined} tick={0} initialRuns={[]} />,
    )
    expect(html).toBe('')
  })

  it('有运行：窄条头 + 展开列表（状态/agent/预览/时长/取消）', () => {
    const html = renderToStaticMarkup(
      <SubagentsRow
        gateway={undefined}
        tick={0}
        initialOpen
        initialRuns={[
          run({ agentType: 'explore' }),
          run({
            sessionId: 'sub-2',
            status: 'completed',
            endedAt: Date.now() - 10_000,
          }),
        ]}
      />,
    )
    expect(html).toContain('subagents-row')
    expect(html).toContain('Subagents · 1 运行中 / 2 总计')
    expect(html).toContain('explore')
    expect(html).toContain('task-agent')
    expect(html).toContain('scan the repo')
    expect(html).toContain('运行中')
    expect(html).toContain('已完成')
    expect(html).toContain('取消')
  })

  it('非运行行不出现取消按钮', () => {
    const html = renderToStaticMarkup(
      <SubagentsRow
        gateway={undefined}
        tick={0}
        initialOpen
        initialRuns={[run({ status: 'failed', endedAt: Date.now() })]}
      />,
    )
    expect(html).toContain('失败')
    expect(html).not.toContain('>取消<')
  })
})
