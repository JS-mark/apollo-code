'use client'

/**
 * 聊天视图：虚拟化消息流（react-virtuoso——变高气泡 + 底部跟随），
 * 消息气泡 memo 化（流式 delta 只重绘最后一条），工具卡/审批卡/提示
 * 固定在输入区上方（不随滚动移出视野），transcript 水合期显示骨架气泡。
 */
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LoadingOutlined,
  PaperClipOutlined,
  RightOutlined,
  SearchOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { Alert, Button, Empty, Input, Tooltip } from 'antd'
import { memo, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { Virtuoso } from 'react-virtuoso'
import remarkGfm from 'remark-gfm'

import {
  chatFeed,
  type ChatMessage,
  type ChatMessageImage,
  type ChatState,
  type SubagentActivity,
  type ToolCard,
  toolLabel,
} from '../lib/chat'
import type { GatewayApi, StagedAttachment } from '../lib/gateway'
import { AskStack } from './AskStack'
import { ChangesCard } from './ChangesCard'
import { PermissionStack } from './PermissionStack'

/** 输入区接受的图片 MIME（与网关 /v1/attachments 白名单一致）。 */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

/** 停摆兜底窗口：turn 在跑且这么久没有任何信封（也无运行中工具）即判终态丢失。 */
const STALL_WINDOW_MS = 5 * 60_000

/** 待发图片 chips 行状态：uploading → ready/error（仅 ready 随提交出站）。 */
export interface PendingImage extends ChatMessageImage {
  /** 输入区 chip 一定有本地预览（选图即建 objectURL）——收窄回必填。 */
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  staged?: StagedAttachment
}

/** 提交时传给父级的图片（staged 必在——uploading/error 已被 send 拦住）。 */
export interface SubmitImage extends ChatMessageImage {
  staged: StagedAttachment
}

/**
 * §2.7bis.5 U3 Task 折叠 chip：Task 卡聚合成一行（🤖 agentType · 当前工具/调用数），
 * 子代理工具 chip 不平铺（冒泡事件已在 reducer 过滤，这里只做展示投影）。
 */
function toolChipLabel(tool: ToolCard, subagents: Record<string, SubagentActivity>): string {
  if (tool.tool !== 'Task') return tool.tool
  const name = `🤖 ${tool.task?.agentType ?? 'subagent'}`
  const activity = tool.turnId ? subagents[tool.turnId] : undefined
  if (!activity) return name
  if (tool.status === 'running' && activity.lastTool) return `${name} · ${activity.lastTool}`
  if (tool.status !== 'running' && activity.toolCalls > 0)
    return `${name} · ${activity.toolCalls} 次调用`
  return name
}

/** AI 回复中的俏皮「正在输入」三点（状态提示与流式气泡尾迹共用；动效在 globals.css）。 */
function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/** 单条消息：memo 隔离——reducer 不可变更新下旧消息对象身份不变，流式期间不重渲染。 */
const MessageBubble = memo(function MessageBubble({
  entry,
  resolveAttachment,
}: {
  entry: ChatMessage
  resolveAttachment: (handle: string) => Promise<string>
}) {
  if (entry.role === 'user' || entry.role === 'system') {
    return (
      <div className={`bubble-row ${entry.role}`}>
        <div className={`bubble ${entry.role === 'user' ? 'user' : 'system'}`}>
          {entry.images?.length ? (
            <div className="msg-images">
              {entry.images.map((image) => (
                <AttachmentImage
                  key={image.chip}
                  image={image}
                  resolveAttachment={resolveAttachment}
                />
              ))}
            </div>
          ) : null}
          {entry.text}
        </div>
      </div>
    )
  }
  return (
    <div className="bubble-row assistant">
      <div className="bubble assistant">
        {entry.thinking && (
          <details className="thinking">
            <summary>
              思考过程
              {entry.streaming && !entry.text && <TypingDots />}
            </summary>
            <div className="thinking-body">{entry.thinking}</div>
          </details>
        )}
        {entry.text && <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>}
        {entry.streaming && <TypingDots />}
      </div>
    </div>
  )
})

/**
 * 消息里的图片：本地预览（objectURL）直出；仅 handle 引用时（transcript 水合/跨端
 * 消息）经网关拉字节转 objectURL，组件卸载即回收（字节缓存留在 gateway 层）。
 */
function AttachmentImage({
  image,
  resolveAttachment,
}: {
  image: ChatMessageImage
  resolveAttachment: (handle: string) => Promise<string>
}) {
  const [src, setSrc] = useState<string | undefined>(image.previewUrl)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (image.previewUrl || !image.handle) return
    let alive = true
    let objectUrl: string | undefined
    resolveAttachment(image.handle)
      .then((url) => {
        if (alive) {
          objectUrl = url
          setSrc(url)
        } else {
          URL.revokeObjectURL(url)
        }
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [image.previewUrl, image.handle, resolveAttachment])
  // 拉不到字节（已清理/链路断）时退回 chip 文本，与 TUI/Web 的回放面一致。
  if (failed || (!image.previewUrl && !image.handle)) return <span>{image.chip}</span>
  if (src === undefined)
    return (
      <span className="msg-image-loading" aria-label={`加载 ${image.chip}`}>
        <LoadingOutlined />
      </span>
    )
  return <img src={src} alt={image.chip} />
}

/** 终端小图标（对齐参考稿的 >_ 方框；antd 无同形图标，内联一份）。 */
function TerminalGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="2.5" width="14" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 6l2.5 2L4 10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** 折叠行工具图标：终端类走 >_ 方框，其余按语义映射 antd 图标。 */
function ToolGlyph({ tool }: { tool: string }) {
  const style = { fontSize: 12 }
  switch (tool) {
    case 'Bash':
    case 'ShellOutput':
    case 'KillShell':
      return <TerminalGlyph />
    case 'Read':
      return <FileTextOutlined style={style} />
    case 'Write':
      return <FileAddOutlined style={style} />
    case 'Edit':
    case 'MultiEdit':
      return <EditOutlined style={style} />
    case 'Glob':
      return <FolderOpenOutlined style={style} />
    case 'Grep':
    case 'WebSearch':
      return <SearchOutlined style={style} />
    case 'WebFetch':
      return <GlobalOutlined style={style} />
    case 'Skill':
      return <ThunderboltOutlined style={style} />
    default:
      return <ToolOutlined style={style} />
  }
}

/** 展开卡头部的复制按钮：Copy→Check +「已复制」（全产品统一惯例）。 */
function ToolCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip title={copied ? '已复制' : '复制'}>
      <Button
        size="small"
        type="text"
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        aria-label={copied ? '已复制' : '复制'}
        onClick={(event) => {
          event.stopPropagation()
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      />
    </Tooltip>
  )
}

/**
 * 会话流里的工具卡：默认折叠成一行（图标 + 中文标签 + 单行目标），点击展开成
 * 详情卡（小写工具名头 + 复制按钮 + 完整入参正文）。Task 卡沿用 toolChipLabel 的
 * 折叠语义（子代理活动聚合成一行），可展开看派发 prompt。无 body 不可展开。
 */
const ToolRow = memo(function ToolRowInner({
  tool,
  subagents,
}: {
  tool: ToolCard
  subagents: Record<string, SubagentActivity>
}) {
  const [open, setOpen] = useState(false)
  const isTask = tool.tool === 'Task'
  const expandable = tool.body !== undefined
  const head = (
    <>
      {isTask ? (
        <span className="tool-name">{toolChipLabel(tool, subagents)}</span>
      ) : (
        <>
          <span className="tool-glyph">
            <ToolGlyph tool={tool.tool} />
          </span>
          <span className="tool-name">{toolLabel(tool.tool)}</span>
          {tool.target ? <span className="tool-target">{tool.target}</span> : null}
        </>
      )}
      {tool.status === 'running' ? (
        isTask ? null : (
          <LoadingOutlined style={{ fontSize: 10, flexShrink: 0 }} />
        )
      ) : tool.status === 'error' ? (
        <span className="tool-status error">失败</span>
      ) : null}
      {expandable ? <RightOutlined className={`tool-chevron${open ? ' open' : ''}`} /> : null}
    </>
  )
  return (
    <div className="tool-block">
      {expandable ? (
        <button
          type="button"
          className="tool-row"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
        </button>
      ) : (
        <div className="tool-row">{head}</div>
      )}
      {expandable && tool.body !== undefined && (
        <div className={`tool-card-wrap${open ? ' open' : ''}`} aria-hidden={!open}>
          <div className="tool-card">
            <div className="tool-card-head">
              <span className="tool-card-title">{tool.tool.toLowerCase()}</span>
              {tool.status === 'running' ? <span className="tool-card-status">运行中</span> : null}
              {tool.status === 'error' ? (
                <span className="tool-card-status error">失败</span>
              ) : null}
              <ToolCopyButton text={tool.body} />
            </div>
            <pre className="tool-card-body">{tool.body}</pre>
          </div>
        </div>
      )}
    </div>
  )
})

/** 导出仅供测试（静态渲染断言折叠/展开面）。 */
export { ToolRow }

/** 水合期骨架气泡的形状（宽×高，模拟即将到来的消息轮廓）。 */
const HYDRATE_BUBBLES = [
  { role: 'assistant', width: 96, height: 40 },
  { role: 'user', width: 72, height: 40 },
  { role: 'assistant', width: 136, height: 64 },
] as const

/** transcript 水合期：俏皮加载（骨架气泡依次漂浮 + 「正在输入」气泡呼吸）。 */
function HydratingSkeleton() {
  return (
    <div aria-busy="true" className="chat-hydrate">
      {HYDRATE_BUBBLES.map(({ role, width, height }, index) => (
        <div key={index} className={`bubble-row ${role}`}>
          <div
            className={`bubble ${role}`}
            style={{ width, height, animationDelay: `${index * 0.35}s, ${index * 0.35}s` }}
          />
        </div>
      ))}
      <div className="chat-hydrate-typing" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="chat-hydrate-caption">对话加载中…</div>
    </div>
  )
}

/** 会话流空态：会话里还没有任何消息时的俏皮引导（主气泡悬浮 + 三点弹跳 + 迷你气泡绕游）。 */
function EmptyStream() {
  return (
    <div className="chat-blank-stream">
      <div className="chat-blank-scene" aria-hidden>
        <span className="chat-blank-mini one" />
        <span className="chat-blank-mini two" />
        <div className="chat-blank-bubble">
          <span className="chat-blank-dot" />
          <span className="chat-blank-dot" />
          <span className="chat-blank-dot" />
        </div>
      </div>
      <div className="chat-blank-title">这里静悄悄的…</div>
      <div className="chat-blank-sub">发条消息，唤醒你的助手 ✨</div>
    </div>
  )
}

/** Virtuoso Footer 的下行数据（经 context prop 传递，组件本体保持模块级稳定引用）。 */
interface ChatFooterContext {
  gateway: GatewayApi | undefined
  activeSessionId: string | undefined
  turn: ChatState['turn']
}

/** 消息流末尾的变更卡片槽位（模块级组件——内联函数每次渲染换身份会让卡片反复重挂载）。 */
function ChatChangesFooter({ context }: { context?: ChatFooterContext }) {
  if (!context?.gateway) return null
  return (
    <div className="chat-item">
      <ChangesCard api={context.gateway} sessionId={context.activeSessionId} turn={context.turn} />
    </div>
  )
}

const virtuosoComponents = { Footer: ChatChangesFooter }

export function ChatView({
  state,
  connected,
  loading,
  activeSessionId,
  gateway,
  onEcho,
  onSubmit,
  onQueuePush,
  onQueueRemove,
  onQueueReorder,
  onNotice,
  onStage,
  onInterrupt,
  onDecide,
  onAnswerAsk,
  resolveAttachment,
  onGoSessions,
  onStall,
}: {
  state: ChatState
  connected: boolean
  /** transcript 水合中（首屏骨架）。 */
  loading: boolean
  activeSessionId: string | undefined
  /** 网关 REST 面（变更卡片数据源）；未配对/未就绪时不渲染卡片。 */
  gateway: GatewayApi | undefined
  onEcho(text: string, images: readonly ChatMessageImage[]): void
  /** text 已是出站 prompt（无文本时以 chip 占位）；images 仅含已暂存完成的。 */
  onSubmit(text: string, images: readonly SubmitImage[]): void
  /** 发送排队：回合进行中提交的消息进队列（自动补发/拖拽排序在页面层与队列 UI）。 */
  onQueuePush(id: string, text: string): void
  onQueueRemove(id: string): void
  onQueueReorder(order: readonly string[]): void
  onNotice(text: string): void
  /** 选图即上传暂存（经网关进本机 AttachmentStore）；失败抛错，chip 转 error 态。 */
  onStage(file: File): Promise<StagedAttachment>
  onInterrupt(): void
  /** kind 为完整决策档位（allow-once/…/deny-forever），gateway 原样透传共享审批队列。 */
  onDecide(requestId: string, kind: string): void
  /** AskUserQuestion 作答（value 缺省 = 跳过）；gateway 原样透传共享提问队列。 */
  onAnswerAsk(requestId: string, value?: string): void
  /** handle 引用图片的字节解析（网关下载 → objectURL；调用方负责稳定引用）。 */
  resolveAttachment(handle: string): Promise<string>
  /** 空态 CTA：跳会话列表选择/新建会话。 */
  onGoSessions(): void
  /** 停摆兜底触发（turn 在跑但长窗口无事件且无运行中工具）：进 reducer 收口流式气泡。 */
  onStall(): void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const chipSeqRef = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)
  // 回合计时（状态提示的秒数）：turn.running 起表，终态归零（对齐 TUI 的 elapsed）。
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (state.turn !== 'running') {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500)
    return () => clearInterval(timer)
  }, [state.turn])

  // 停摆兜底：turn 在跑但 STALL_WINDOW 内没有任何信封、也没有运行中的工具
  // （长 Bash 是合法静默，不能误报）——终态帧大概率丢了（断线窗口/机器侧静
  // 默崩）。收口流式气泡并提示一次；新事件到达后自动重新武装。
  const stallFiredRef = useRef(0)
  useEffect(() => {
    stallFiredRef.current = 0
  }, [state.turn, state.lastEventAt])
  useEffect(() => {
    if (state.turn !== 'running') return
    const timer = setInterval(() => {
      if (Date.now() - state.lastEventAt < STALL_WINDOW_MS) return
      if (stallFiredRef.current > state.lastEventAt) return
      if (state.tools.some((tool) => tool.status === 'running')) return
      stallFiredRef.current = Date.now()
      onStall()
    }, 1_000)
    return () => clearInterval(timer)
  }, [state.turn, state.lastEventAt, state.tools, onStall])

  const pickImages = (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      chipSeqRef.current += 1
      const chip = `[image_${chipSeqRef.current}]`
      const previewUrl = URL.createObjectURL(file)
      setImages((current) => [...current, { chip, previewUrl, status: 'uploading' }])
      onStage(file)
        .then((staged) =>
          setImages((current) =>
            current.map((item) =>
              item.chip === chip ? { ...item, status: 'ready', staged } : item,
            ),
          ),
        )
        .catch(() =>
          setImages((current) =>
            current.map((item) => (item.chip === chip ? { ...item, status: 'error' } : item)),
          ),
        )
    }
  }

  const removeImage = (chip: string) => {
    setImages((current) => {
      const target = current.find((item) => item.chip === chip)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.chip !== chip)
    })
  }

  const send = () => {
    const value = text.trim()
    const ready = images.filter((item) => item.status === 'ready' && item.staged)
    if (!value && !ready.length) return
    // 上传在途时拦下发送，避免漏图（chip 上有转圈，等转完再发）。
    if (images.some((item) => item.status === 'uploading')) return
    // 发送排队：回合进行中提交 → 进可见队列，回合终态后自动逐条补发。
    // 带图片的消息不排队（staged handle 有时效），提示等空闲再发。
    if (state.turn === 'running') {
      if (ready.length > 0) {
        onNotice('当前回合进行中：带图片的消息请等回合结束后再发送')
        return
      }
      onQueuePush(`q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, value)
      setText('')
      return
    }
    onEcho(
      value,
      ready.map((item) => ({
        chip: item.chip,
        previewUrl: item.previewUrl,
        // 顺手带上 handle：本地预览失效（回显被水合替换）时仍有取字节的退路。
        ...(item.staged?.handle ? { handle: item.staged.handle } : {}),
      })),
    )
    onSubmit(value || ready.map((item) => item.chip).join(' '), ready as readonly SubmitImage[])
    setText('')
    setImages([])
  }

  const messages = state.messages
  const feed = chatFeed(state)
  const showSkeleton = loading && messages.length === 0 && state.tools.length === 0
  // 状态提示（对齐 TUI StreamingStatus：动词 · 秒数 · ↑ tokens）：阶段取最后一个
  // 运行中的工具卡（无则思考/等待模型）；中断入口在 composer 的「中断」按钮。
  const runningTool = state.tools.findLast((tool) => tool.status === 'running')
  const runningToolLabel = runningTool
    ? runningTool.tool === 'Task'
      ? '子代理'
      : toolLabel(runningTool.tool)
    : undefined
  const streamedTokens = Math.round(state.streamedChars / 4)
  const runningHint =
    runningToolLabel !== undefined
      ? `正在运行 ${runningToolLabel}…`
      : elapsed < 2
        ? '正在思考…'
        : '思考中…'

  // 中断提示上的「重试」：重发最后一条已收口的 user 消息（乐观回显不重发；
  // 纯图消息 chip 剥离后 text 为空，没有可重发的文本，不出现按钮）。
  const lastUserText = [...state.messages]
    .reverse()
    .find((message) => message.role === 'user' && !message.local && !!message.text.trim())?.text
  const retryLast = () => {
    if (lastUserText) onSubmit(lastUserText, [])
  }

  // 无活动会话：整页空态引导（创建/恢复只从会话列表发起，输入区不出现）。
  if (activeSessionId === undefined && !loading) {
    return (
      <div className="chat-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有进行中的会话">
          <Button type="primary" onClick={onGoSessions}>
            去选择会话
          </Button>
        </Empty>
        {state.notice && (
          <Alert
            type="warning"
            showIcon={false}
            title={state.notice}
            closable
            style={{ fontSize: 12, marginTop: 12 }}
          />
        )}
      </div>
    )
  }

  return (
    <>
      {showSkeleton ? (
        <div className="chat-scroll chat-item">
          <HydratingSkeleton />
        </div>
      ) : feed.length === 0 ? (
        <div className="chat-scroll">
          <EmptyStream />
        </div>
      ) : (
        <Virtuoso
          className="chat-scroll"
          data={feed}
          initialTopMostItemIndex={Math.max(0, feed.length - 1)}
          followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          computeItemKey={(_, entry) => entry.key}
          context={{ gateway, activeSessionId, turn: state.turn }}
          components={virtuosoComponents}
          itemContent={(_, entry) => (
            <div className="chat-item">
              {entry.kind === 'message' ? (
                <MessageBubble entry={entry.message} resolveAttachment={resolveAttachment} />
              ) : (
                <ToolRow tool={entry.tool} subagents={state.subagents} />
              )}
            </div>
          )}
        />
      )}
      <div className="chat-overlay">
        {/* 状态行只在正文开始流出后让位：思考流也是 streaming 消息，但那段时间
            恰恰最需要「思考中 · 秒数」的进度反馈（web 思考行同口径）。 */}
        {state.turn === 'running' &&
          !messages.some((message) => message.streaming && message.text) && (
            <div className="overlay-hint">
              {runningHint}
              {elapsed >= 2 ? `（${elapsed}s` : ''}
              {elapsed >= 2 && streamedTokens > 0 ? ` · ↑ ${streamedTokens} tokens` : ''}
              {elapsed >= 2 ? '）' : ''}
              <TypingDots />
            </div>
          )}
        {/* 用户主动中断：灰字弱化 + 重试（不是报错，不进警示条）。 */}
        {state.interrupted && (
          <div className="overlay-hint chat-interrupted">
            <span>已中断本次回复</span>
            {lastUserText && (
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto' }}
                onClick={retryLast}
              >
                重试
              </Button>
            )}
          </div>
        )}
        {state.notice && (
          <Alert
            type="warning"
            showIcon={false}
            title={state.notice}
            closable
            style={{ fontSize: 12 }}
          />
        )}
        {state.permissions.length > 0 && (
          <PermissionStack
            permissions={state.permissions}
            onDecide={(requestId, kind) => onDecide(requestId, kind)}
          />
        )}
        {state.asks.length > 0 && (
          <AskStack
            asks={state.asks}
            onAnswer={(requestId, value) => onAnswerAsk(requestId, value)}
          />
        )}
      </div>
      {state.sendQueue.length > 0 && (
        <SendQueueList
          queue={state.sendQueue}
          onRemove={onQueueRemove}
          onReorder={onQueueReorder}
        />
      )}
      <div className="composer-wrap">
        {images.length > 0 && (
          <div className="chips">
            {images.map((image) => (
              <span key={image.chip} className={`chip ${image.status}`}>
                <img src={image.previewUrl} alt={image.chip} />
                {image.status === 'uploading' && <LoadingOutlined className="chip-status" />}
                {image.status === 'error' && <span className="chip-status">失败</span>}
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`移除 ${image.chip}`}
                  onClick={() => removeImage(image.chip)}
                >
                  <CloseOutlined style={{ fontSize: 10 }} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer">
          <button
            type="button"
            className="attach-btn"
            aria-label="添加图片"
            disabled={!connected}
            onClick={() => fileRef.current?.click()}
          >
            <PaperClipOutlined style={{ fontSize: 18 }} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              pickImages(event.target.files)
              // 允许重选同一文件（值不变不触发 change）。
              event.target.value = ''
            }}
          />
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={connected ? '发消息…' : '连接中…'}
            disabled={!connected}
            onPressEnter={send}
            enterKeyHint="send"
            style={{ borderRadius: 18 }}
          />
          {state.turn === 'running' ? (
            <Button type="text" danger icon={<StopOutlined />} onClick={onInterrupt}>
              中断
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={
                !connected ||
                (!text.trim() && !images.some((item) => item.status === 'ready')) ||
                images.some((item) => item.status === 'uploading')
              }
              onClick={send}
              style={{ borderRadius: 18 }}
            >
              发送
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

/** 触摸拖拽的行高（与 .send-queue-row 固定高度一致；改样式须同步）。 */
const SEND_QUEUE_ROW_HEIGHT = 36

/**
 * 发送队列（mobile）：触摸拖拽排序 + 移出。拖拽手柄 `touch-action: none` 防
 * 页面滚动，move 时按行高换算目标位、实时 dispatch 重排（web 侧为 HTML5 dnd）。
 */
function SendQueueList({
  queue,
  onRemove,
  onReorder,
}: {
  queue: readonly { id: string; text: string }[]
  onRemove(id: string): void
  onReorder(order: readonly string[]): void
}) {
  const dragRef = useRef<{ id: string; startIndex: number; startY: number } | undefined>(undefined)
  return (
    <div className="send-queue" aria-label="发送队列">
      {queue.map((item, index) => (
        <div key={item.id} className="send-queue-row">
          <span
            className="send-queue-handle"
            aria-label={`拖动排序：${item.text}`}
            onTouchStart={(event) => {
              const touch = event.touches[0]!
              dragRef.current = { id: item.id, startIndex: index, startY: touch.clientY }
            }}
            onTouchMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.id !== item.id) return
              const touch = event.touches[0]!
              const delta = Math.round((touch.clientY - drag.startY) / SEND_QUEUE_ROW_HEIGHT)
              const target = Math.max(0, Math.min(queue.length - 1, drag.startIndex + delta))
              if (target === index) return
              const order = queue.map((entry) => entry.id)
              order.splice(target, 0, ...order.splice(index, 1))
              onReorder(order)
              drag.startIndex = target
              event.preventDefault()
            }}
            onTouchEnd={() => {
              dragRef.current = undefined
            }}
          >
            ≡
          </span>
          <span className="send-queue-text">
            {index + 1}. {item.text}
          </span>
          <button
            type="button"
            className="send-queue-remove"
            aria-label="移出队列"
            onClick={() => onRemove(item.id)}
          >
            <CloseOutlined style={{ fontSize: 10 }} />
          </button>
        </div>
      ))}
    </div>
  )
}
