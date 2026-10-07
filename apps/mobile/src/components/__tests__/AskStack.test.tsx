import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { AskCard } from '../../lib/chat'
import { I18nProvider } from '../../lib/i18n'
import { AskStack } from '../AskStack'

const ask = (overrides: Partial<AskCard> = {}): AskCard => ({
  id: 'a-1',
  question: '用哪个方案？',
  options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
  ...overrides,
})

/** 静态渲染包 I18nProvider：useI18n 默认上下文 t 直返 key，无 Provider 会丢中文断言。 */
const render = (ui: React.ReactElement): string =>
  renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>)

describe('AskStack（移动端提问卡：选项 + 自由文本）', () => {
  it('渲染问题、选项按钮、自定义回答输入行与跳过', () => {
    const html = render(<AskStack asks={[ask()]} onAnswer={() => {}} />)
    expect(html).toContain('用哪个方案？')
    expect(html).toContain('方案 A')
    expect(html).toContain('快')
    // 自由文本回答行（与 web 卡片同语义）：输入 + 发送。
    expect(html).toContain('askstack-freetext-input')
    expect(html).toContain('自定义回答')
    expect(html).toContain('askstack-freetext-send')
    expect(html).toContain('跳过（不作答）')
  })

  it('倒计时：带 expiresAt 渲染剩余秒数；旧网关（无截止）不渲染', () => {
    const withDeadline = render(
      <AskStack asks={[ask({ expiresAt: Date.now() + 60_000 })]} onAnswer={() => {}} />,
    )
    expect(withDeadline).toContain('后自动关闭')
    const withoutDeadline = render(<AskStack asks={[ask()]} onAnswer={() => {}} />)
    expect(withoutDeadline).not.toContain('后自动关闭')
  })

  it('空队列：不渲染任何卡片', () => {
    const html = render(<AskStack asks={[]} onAnswer={() => {}} />)
    expect(html).not.toContain('askstack')
  })
})
