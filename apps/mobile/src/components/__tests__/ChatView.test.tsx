import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { initialChatState, type ChatState, type ToolCard } from '../../lib/chat'
import type { StagedAttachment } from '../../lib/gateway'
import { ChatView, ToolRow } from '../ChatView'

const staged: StagedAttachment = { kind: 'image', mime: 'image/png', size: 1, handle: 'h-1' }

const state = (overrides: Partial<ChatState> = {}): ChatState => ({
  ...initialChatState,
  ...overrides,
})

const props = (overrides: { loading?: boolean; noSession?: boolean } = {}) => ({
  state: initialChatState,
  connected: true,
  loading: overrides.loading ?? false,
  activeSessionId: overrides.noSession ? undefined : 'sess-1',
  gateway: undefined,
  onEcho: () => {},
  onSubmit: () => {},
  onStage: () => Promise.resolve(staged),
  onInterrupt: () => {},
  onDecide: () => {},
  onAnswerAsk: () => {},
  resolveAttachment: () => Promise.resolve('blob:x'),
  onGoSessions: () => {},
  onStall: () => {},
  onQueuePush: () => {},
  onQueueRemove: () => {},
  onQueueReorder: () => {},
  onNotice: () => {},
})

describe('ChatView 会话流空态（有会话无消息）', () => {
  it('空流：渲染俏皮空态（气泡场景 + 引导文案）', () => {
    const html = renderToStaticMarkup(<ChatView {...props()} />)
    expect(html).toContain('chat-blank-stream')
    expect(html).toContain('chat-blank-bubble')
    expect(html).toContain('这里静悄悄的')
    expect(html).toContain('唤醒你的助手')
  })

  it('有消息：不渲染空态', () => {
    const html = renderToStaticMarkup(
      <ChatView
        {...props()}
        state={state({
          messages: [{ id: 'm-1', role: 'user', text: '你好', seq: 1 }],
        })}
      />,
    )
    expect(html).not.toContain('chat-blank-stream')
  })

  it('transcript 水合中：俏皮加载动画优先于空态', () => {
    const html = renderToStaticMarkup(<ChatView {...props({ loading: true })} />)
    expect(html).not.toContain('chat-blank-stream')
    expect(html).toContain('aria-busy')
    expect(html).toContain('chat-hydrate-typing')
    expect(html).toContain('对话加载中')
  })

  it('无活动会话：走整页空态引导（不是会话流空态）', () => {
    const html = renderToStaticMarkup(<ChatView {...props({ noSession: true })} />)
    expect(html).not.toContain('chat-blank-stream')
    expect(html).toContain('没有进行中的会话')
  })

  it('工具卡默认折叠：渲染折叠行（图标+中文标签+目标+箭头），展开卡隐藏', () => {
    const tool: ToolCard = {
      toolUseId: 'tu-1',
      tool: 'Bash',
      status: 'done',
      target: 'pnpm build',
      body: 'pnpm build 2>&1\n| tail -15',
    }
    const html = renderToStaticMarkup(<ToolRow tool={tool} subagents={{}} />)
    // 折叠行：中文标签 + 单行目标 + 可展开箭头；展开卡常驻 DOM 但处于收起态。
    expect(html).toContain('tool-row')
    expect(html).toContain('终端')
    expect(html).toContain('pnpm build')
    expect(html).toContain('tool-chevron')
    expect(html).not.toContain('tool-card-wrap open')
    expect(html).toContain('aria-hidden="true"')
  })
})
