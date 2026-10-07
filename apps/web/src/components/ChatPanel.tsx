'use client'

import {
  ArrowUpOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HistoryOutlined,
  HolderOutlined,
  LinkOutlined,
  LoadingOutlined,
  PlusOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { Alert, Button, Dropdown, Input, Popover, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ModelsView, SessionSummary, StagedAttachment, WebApi } from '../lib/api'
import {
  mentionFileCandidates,
  mentionQueryAt,
  mentionChipLabel,
  replaceMentionToken,
} from '../lib/composer-mention'
import {
  arrowDownNavigatesHistory,
  arrowUpOpensHistory,
  historyDown,
  historyUp,
  historyValue,
  initialInputHistory,
  resetHistoryNavigation,
  type InputHistoryState,
} from '../lib/input-history'
import type { ChatImage, ChatMessage, SubagentActivity, ToolCard } from '../lib/session-stream'
import { chatImageSrc, chatFeedGrouped, toolLabel, useSessionStream } from '../lib/session-stream'
import { slashCandidates, slashQueryAt } from '../lib/slash-commands'
import { BrandMark } from './BrandMark'
import { ChangesCard } from './ChangesCard'
import { Markdown } from './Markdown'
import { PermissionLineageBadge } from './PermissionLineageBadge'
import { NewChatIcon, WorkbenchIcon } from './WorkbenchPanel'

/** composer 里待提交的图片：先本地预览（objectURL），上传完成得 handle 才可发送。 */
interface PendingImage {
  chip: string
  mime: string
  previewUrl: string
  status: 'uploading' | 'ready' | 'error'
  staged?: StagedAttachment
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

/** 三档权限模式：label/desc 全产品统一口径（SettingsPage 同步引用此处文案）。 */
export const PERMISSION_MODES = [
  { id: 'ask', label: '询问', desc: '每次操作都需确认' },
  { id: 'auto', label: '自动', desc: '自动放行低风险操作，高风险仍确认' },
  { id: 'full', label: '放行', desc: '不再询问任何操作（慎用）' },
] as const

/** 时间分隔行：相邻消息间隔超过该阈值才再出一次（对齐 IM 惯例）。 */
const TIME_GAP_MS = 5 * 60_000

/**
 * §2.7bis.5 U3 Task 折叠行：Task 卡聚合成一行（🤖 agentType · 状态 · 当前工具/调用数），
 * 子代理工具行不平铺（冒泡事件已在 reducer 过滤，这里只做展示投影）。
 */
function toolRowText(
  tool: ToolCard,
  subagents: Record<string, SubagentActivity>,
): { name: string; status: string } {
  const base = tool.status === 'running' ? '运行中…' : tool.status === 'error' ? '失败' : '完成'
  if (tool.tool !== 'Task') return { name: tool.tool, status: base }
  const name = `🤖 ${tool.task?.agentType ?? '子代理'}`
  const activity = tool.turnId ? subagents[tool.turnId] : undefined
  if (!activity) return { name, status: base }
  if (tool.status === 'running' && activity.lastTool)
    return { name, status: `${base} · ${activity.lastTool}` }
  if (tool.status !== 'running' && activity.toolCalls > 0)
    return { name, status: `${base} · ${activity.toolCalls} 次工具调用` }
  return { name, status: base }
}

const formatHHMM = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** AI 回复中的俏皮「正在输入」三点（思考行与流式尾迹共用；动效在 globals.css）。 */
function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

/** 终端小图标（对齐参考稿的 >_ 方框；antd 无同形图标，内联一份）。 */
function TerminalGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
  const style = { fontSize: 13 }
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
 * 工具调用卡：默认折叠成一行（图标 + 中文标签 + 单行目标），点击展开成详情卡
 * （小写工具名头 + 复制按钮 + 完整入参正文）；Task 卡沿用子代理聚合文案，可展开看
 * 派发 prompt。无 body（迟到 started 建卡/无 input）时不可展开。
 */
function ToolRowCard({
  tool,
  subagents,
}: {
  tool: ToolCard
  subagents: Record<string, SubagentActivity>
}) {
  const [open, setOpen] = useState(false)
  const isTask = tool.tool === 'Task'
  const row = toolRowText(tool, subagents)
  const expandable = tool.body !== undefined
  const head = (
    <>
      {isTask ? (
        <span className="tool-name">{row.name}</span>
      ) : (
        <>
          <span className="tool-glyph">
            <ToolGlyph tool={tool.tool} />
          </span>
          <span className="tool-name">{toolLabel(tool.tool)}</span>
          {tool.target ? <span className="tool-target">{tool.target}</span> : null}
        </>
      )}
      {!isTask && tool.status === 'done' && (tool.linesAdded || tool.linesRemoved) ? (
        <span className="tool-delta">
          +{tool.linesAdded ?? 0} −{tool.linesRemoved ?? 0}
        </span>
      ) : null}
      {tool.status === 'running' ? (
        isTask ? (
          <span className="tool-status">{row.status}</span>
        ) : (
          <LoadingOutlined className="tool-spin" />
        )
      ) : tool.status === 'error' ? (
        <span className="tool-status error">失败</span>
      ) : isTask ? (
        <span className="tool-status">{row.status}</span>
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
              {tool.status === 'running' ? <span className="tool-card-status">运行中…</span> : null}
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
}

/**
 * 连续工具行分组：相邻 ≥2 张工具卡默认折成「N 次工具调用」一行，展开后逐行
 * 渲染原 ToolRowCard（行内仍可再展开详情卡）。分组头是折叠态唯一的状态面，
 * 聚合展示进度——部分完成「K 个完成 · M 个运行中」（带 spinner）、有失败红标
 * 「F 个失败」；全部收口且无失败时只剩条数。key 由 chatFeedGrouped 取首卡
 * toolUseId——运行中追加新卡不换 key，展开态跨重渲染保持。
 */
function ToolGroupCard({
  tools,
  subagents,
}: {
  tools: ToolCard[]
  subagents: Record<string, SubagentActivity>
}) {
  const [open, setOpen] = useState(false)
  const running = tools.filter((tool) => tool.status === 'running').length
  const failed = tools.filter((tool) => tool.status === 'error').length
  const done = tools.length - running - failed
  const progress = [
    ...(running > 0 && done > 0 ? [`${done} 个完成`] : []),
    ...(running > 0 ? [`${running} 个运行中`] : []),
  ]
  return (
    <div className="tool-block">
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {running > 0 ? <LoadingOutlined className="tool-spin" /> : null}
        <span className="tool-name">{tools.length} 次工具调用</span>
        {progress.length > 0 ? <span className="tool-target">{progress.join(' · ')}</span> : null}
        {failed > 0 ? <span className="tool-status error">{failed} 个失败</span> : null}
        <RightOutlined className={`tool-chevron${open ? ' open' : ''}`} />
      </button>
      <div className={`tool-group-wrap${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="tool-group-body">
          {tools.map((tool) => (
            <ToolRowCard key={tool.toolUseId} tool={tool} subagents={subagents} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 聊天视图（§22 W-04/W-05/W-07；布局对齐 CodeBuddy 参考：欢迎屏 + 居中会话头 +
 * 用户气泡右置/助手全文 + 思考行 + 圆角 composer 卡片）。
 * 状态唯一来源是 useSessionStream 的 reducer——SSE 增量、transcript 水合、
 * 本地乐观回显全走同一管道（历史上双轨并行导致流式消息不可见）。
 */
export function ChatPanel({
  api,
  cwd,
  sessionId,
  sessionTitle,
  embedded,
  connected,
  capabilities,
  sessions,
  connectOpen,
  workbenchOpen,
  onToggleConnect,
  onToggleWorkbench,
  onOpenChanges,
  onOpenFile,
  onResumeSession,
  onFocusSessionSearch,
  onSessionChange,
  onSessionsChanged,
}: {
  api: WebApi
  cwd: string
  sessionId: string | undefined
  sessionTitle: string | undefined
  embedded: boolean
  connected: boolean
  capabilities: Record<string, unknown>
  /** 全部会话（最近会话弹层数据源；按 updatedAt 倒序展示本工作区的）。 */
  sessions: readonly SessionSummary[]
  connectOpen: boolean
  workbenchOpen: boolean
  onToggleConnect(): void
  onToggleWorkbench(): void
  /** 变更卡片「审查」：打开工作台「文件变更」标签页并定位该文件的 diff。 */
  onOpenChanges(path: string): void
  /** 变更卡片「打开」：工作台文件查看器。 */
  onOpenFile(path: string): void
  /** 恢复历史会话（resume + 切路由由 AppShell 统一做）。 */
  onResumeSession(id: string): void
  /** 最近会话弹层底部「搜索并管理全部对话」：聚焦侧栏搜索框。 */
  onFocusSessionSearch(): void
  onSessionChange(id: string | undefined): void
  onSessionsChanged(): void
}) {
  const stream = useSessionStream(sessionId !== undefined, sessionId)
  const chat = stream.state
  const [draft, setDraft] = useState(() => localStorage.getItem(`volund-web-draft:${cwd}`) ?? '')
  // W-05：@-picker / slash 面板 / 历史输入。键序（对齐 TUI）：mention > slash > history > Enter。
  const [mention, setMention] = useState<{
    query: string
    files: readonly string[]
    active: number
  }>()
  const [slashActive, setSlashActive] = useState(0)
  const [inputHistory, setInputHistory] = useState<InputHistoryState>(initialInputHistory)
  const textareaSelectionRef = useRef(0)
  const fileQueryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [images, setImages] = useState<PendingImage[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chipSeqRef = useRef(0)
  const [models, setModels] = useState<ModelsView>()
  const [modelOverride, setModelOverride] = useState<string>()
  const [recentOpen, setRecentOpen] = useState(false)

  // 回合计时：turn.started 打点、idle 时结算出「已思考 · X 秒 · N 个步骤」。
  const [elapsed, setElapsed] = useState(0)
  const [turnStats, setTurnStats] = useState<{ seconds: number; steps: number }>()
  const turnStartRef = useRef<number | undefined>(undefined)
  const toolBaseRef = useRef(0)
  const toolsLenRef = useRef(0)
  toolsLenRef.current = chat.tools.length

  // ⌘⇧H：切换「最近会话」弹层（对齐 CodeBuddy web 的快捷键）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        setRecentOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 回合计时器：running 期间每秒跳动；转 idle 结算统计（步骤=本回合工具数）。
  useEffect(() => {
    if (chat.turn === 'running') {
      turnStartRef.current = Date.now()
      toolBaseRef.current = toolsLenRef.current
      setTurnStats(undefined)
      setElapsed(0)
      const timer = setInterval(() => {
        if (turnStartRef.current !== undefined)
          setElapsed(Math.floor((Date.now() - turnStartRef.current) / 1000))
      }, 500)
      return () => clearInterval(timer)
    }
    if (turnStartRef.current !== undefined) {
      setTurnStats({
        seconds: Math.max(1, Math.round((Date.now() - turnStartRef.current) / 1000)),
        steps: toolsLenRef.current - toolBaseRef.current,
      })
      turnStartRef.current = undefined
    }
  }, [chat.turn])

  // 最近会话：本工作区、按更新时间倒序、取前 8 条（对齐参考弹层）。
  const recentSessions = sessions
    .filter((session) => session.cwd === cwd && session.id !== sessionId)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8)
  const projectName = cwd.split('/').filter(Boolean).pop() ?? cwd

  // W-06/§4.4：模型候选与权限模式（能力门控——未接线不渲染）。权限档位的
  // 唯一状态源是 stream.state.permissionMode：这里拉取写进 reducer，之后靠
  // SSE permission.mode 帧保持同步（TUI /mode、他端选择器、g 授权都会推帧）；
  // sessionId 进依赖——切会话后重建的权限链档位可能不同，必须重拉。
  useEffect(() => {
    if (capabilities.models === true)
      void api
        .models()
        .then(setModels)
        .catch(() => setModels(undefined))
    if (capabilities.permissionMode === true)
      void api
        .permissionMode()
        .then((result) => stream.setPermissionMode(result.mode))
        .catch(() => {
          // 拉取失败保持未知（选择器隐藏）；SSE 帧到达后仍会回填。
        })
  }, [api, capabilities.models, capabilities.permissionMode, sessionId, stream.setPermissionMode])

  // 会话切换：重置后按 transcript 水合（SSE 增量叠加其上）。
  // 注意：undefined → 新建id 是「首条消息自动建会话」路径——composer 里正在
  // 上传/待发的图片 chip 必须保留，不能当作会话切换清掉。
  const prevSessionRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const leavingRealSession = prevSessionRef.current !== undefined
    prevSessionRef.current = sessionId
    stream.reset()
    if (leavingRealSession) setImages([])
    if (sessionId === undefined) return
    void api
      .transcript()
      .then((snapshot) => stream.hydrate(snapshot.transcript))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sessionId])

  // 草稿自动保存（W-05）：按 cwd 隔离，发送后清空。
  useEffect(() => {
    localStorage.setItem(`volund-web-draft:${cwd}`, draft)
  }, [cwd, draft])

  // textarea 随内容自动长高（上限 200px，超出内部滚动）。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [draft])

  // 消息列表自动滚底（用户上翻时不打断）。
  useEffect(() => {
    if (nearBottomRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat.messages, chat.tools])

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId
    const { id } = await api.startSession(cwd)
    onSessionChange(id)
    onSessionsChanged()
    return id
  }, [api, cwd, sessionId, onSessionChange, onSessionsChanged])

  const addImages = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        chipSeqRef.current += 1
        const chip = `[image_${chipSeqRef.current}]`
        const previewUrl = URL.createObjectURL(file)
        setImages((current) => [
          ...current,
          { chip, mime: file.type, previewUrl, status: 'uploading' },
        ])
        void (async () => {
          try {
            await ensureSession()
            const staged = await api.stageAttachment(file, file.type)
            setImages((current) =>
              current.map((item) =>
                item.chip === chip ? { ...item, status: 'ready', staged } : item,
              ),
            )
          } catch (cause) {
            setImages((current) =>
              current.map((item) => (item.chip === chip ? { ...item, status: 'error' } : item)),
            )
            stream.setNotice(cause instanceof Error ? cause.message : String(cause))
          }
        })()
      }
    },
    [api, ensureSession, stream],
  )

  // ── W-05：draft/selection → mention & slash 派生态 ────────────────────────
  const mentionQuery =
    mention !== undefined ? mentionQueryAt(draft, textareaSelectionRef.current) : undefined
  const mentionList =
    mention !== undefined && mentionQuery !== undefined
      ? mentionFileCandidates(mentionQuery.query, mention.files ?? [])
      : []
  const slashQuery = slashQueryAt(draft)
  const slashList = slashQuery !== undefined ? slashCandidates(slashQuery) : []
  const mentionOpen = mentionList.length > 0
  const slashOpen = slashList.length > 0

  const historyPut = (state: InputHistoryState) => {
    setInputHistory(state)
    const value = historyValue(state)
    if (value !== null) setDraft(value)
  }

  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    const selectionStart = textareaSelectionRef.current
    // 1) @-mention 弹层
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setMention((current) =>
          current
            ? {
                ...current,
                active:
                  event.key === 'ArrowDown'
                    ? (current.active + 1) % mentionList.length
                    : (current.active - 1 + mentionList.length) % mentionList.length,
              }
            : current,
        )
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(undefined)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const candidate = mentionList[mention?.active ?? 0]
        if (!candidate) return
        void attachFileCandidate(candidate.path)
        return
      }
    }
    // 2) slash 面板
    if (slashOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashActive((current) =>
          event.key === 'ArrowDown'
            ? (current + 1) % slashList.length
            : (current - 1 + slashList.length) % slashList.length,
        )
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDraft(`/${slashQuery ?? ''}`) // 关闭面板：补空格退出 slash 语义
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const command = slashList[slashActive]
        if (!command) return
        setDraft('')
        void command.run({
          hasActiveSession: sessionId !== undefined,
          interrupt: () => void api.interrupt().catch(() => {}),
          endSession: () => {
            void api
              .endSession()
              .then(() => onSessionChange(undefined))
              .catch(() => {})
          },
          notice: (value) => stream.setNotice(value),
        })
        return
      }
    }
    // 3) 历史输入（↑ 首行 / ↓ 历史态末行）
    if (event.key === 'ArrowUp' && arrowUpOpensHistory(draft, selectionStart)) {
      event.preventDefault()
      historyPut(historyUp(inputHistory, draft))
      return
    }
    if (
      event.key === 'ArrowDown' &&
      arrowDownNavigatesHistory(inputHistory, draft, selectionStart)
    ) {
      event.preventDefault()
      historyPut(historyDown(inputHistory))
      return
    }
    // 4) Enter 发送
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  // @ 选中：走会话 attachFilePath（TUI 同语义）；unavailable → 官方降级（插纯路径）。
  const attachFileCandidate = async (path: string) => {
    setMention(undefined)
    const next = replaceMentionToken(draft, mentionQuery?.query ?? '')
    try {
      const result = await api.attachFilePath(path)
      if (result.kind === 'attached') {
        const chip = mentionChipLabel(path)
        setDraft(`${next}${chip} `)
        setPendingFileAttachments((current) => [
          ...current,
          {
            chip,
            path,
            mime: result.attachment.mime,
            size: result.attachment.size,
            ...(result.attachment.handle !== undefined ? { handle: result.attachment.handle } : {}),
          },
        ])
        return
      }
    } catch {
      // 无会话/未接线 → 官方降级：插入纯路径文本
    }
    setDraft(`${next}${path} `)
  }

  const send = useCallback(
    async (text: string, options?: { queued?: boolean }) => {
      const trimmed = text.trim()
      const ready = images.filter((item) => item.status === 'ready' && item.staged)
      if (!trimmed && ready.length === 0) return
      // 发送排队：回合进行中提交 → 进可见队列，回合终态后由补发 effect 逐条发出。
      // 带图片的消息不排队（staged handle 有时效），提示等空闲再发。
      if (chat.turn === 'running' && !options?.queued) {
        if (ready.length > 0 || images.some((item) => item.status === 'uploading')) {
          stream.setNotice('当前回合进行中：带图片的消息请等回合结束后再发送')
          return
        }
        stream.queuePush(`q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, trimmed)
        setDraft('')
        stream.setNotice(undefined)
        return
      }
      if (images.some((item) => item.status === 'uploading')) return
      setBusy(true)
      setDraft('')
      stream.setNotice(undefined)
      nearBottomRef.current = true
      try {
        // 无活动会话时先创建（runner 激活要数秒）——busy 期间 composer 给出明确反馈。
        await ensureSession()
        const echoImages: ChatImage[] = ready.map((item) => ({
          chip: item.chip,
          mime: item.mime,
          previewUrl: item.previewUrl,
          // 兜底：blob 预览失效（如收口后被 React 重挂载）时经字节端点加载。
          ...(item.staged!.handle ? { handle: item.staged!.handle } : {}),
        }))
        stream.echo(trimmed, echoImages)
        setImages([])
        // W-05：@-picker 的 file 附件随提交出站（chip 由服务端 stripAttachmentChips 剥离）。
        const files = pendingFileAttachmentsRef.current
        setPendingFileAttachments([])
        // prompt 为空但带图时以 chip 占位（server 要求非空 prompt；提交时 chip 会被剥离）。
        const prompt = trimmed || ready.map((item) => item.chip).join(' ')
        await api.submitTurn(prompt, {
          ...(modelOverride ? { model: modelOverride } : {}),
          attachments: [
            ...ready.map((item) => ({
              kind: 'image' as const,
              chip: item.chip,
              mime: item.mime,
              size: item.staged!.size,
              ...(item.staged!.handle ? { handle: item.staged!.handle } : {}),
            })),
            ...files.map((file) => ({
              kind: 'file' as const,
              chip: file.chip,
              mime: file.mime ?? 'application/octet-stream',
              size: file.size ?? 0,
              ...(file.handle !== undefined ? { handle: file.handle } : {}),
              path: file.path,
            })),
          ],
        })
      } catch (cause) {
        stream.setNotice(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
        textareaRef.current?.focus()
      }
    },
    [api, chat.turn, ensureSession, images, modelOverride, stream],
  )

  // 排队补发：回合终态边沿（running → idle）逐条发出队首。submit 失败时乐观
  // 回显已入流、notice 已提示——与手动发送失败同路径，靠「重试」兜底，不自动回队。
  const prevTurnRef = useRef(chat.turn)
  const firingRef = useRef(false)
  useEffect(() => {
    const previous = prevTurnRef.current
    prevTurnRef.current = chat.turn
    if (previous !== 'running' || chat.turn !== 'idle' || firingRef.current) return
    const head = chat.sendQueue[0]
    if (!head) return
    firingRef.current = true
    stream.queueRemove(head.id)
    void send(head.text, { queued: true }).finally(() => {
      firingRef.current = false
    })
  }, [chat.turn, chat.sendQueue, send, stream])

  // 发送队列 UI：拖拽排序（HTML5 dnd，桌面鼠标）+ 移出；渲染在 composer 上方。
  const dragIdRef = useRef<string | undefined>(undefined)
  const [draggingId, setDraggingId] = useState<string>()
  const [pendingFileAttachments, setPendingFileAttachments] = useState<
    { chip: string; path: string; mime: string; size: number; handle?: string }[]
  >([])
  // send 是 useCallback 闭包——经 ref 读取最新待发 file 附件，避免依赖链膨胀。
  const pendingFileAttachmentsRef = useRef(pendingFileAttachments)
  pendingFileAttachmentsRef.current = pendingFileAttachments
  const queueBlock =
    chat.sendQueue.length > 0 ? (
      <div className="send-queue" aria-label="发送队列">
        {chat.sendQueue.map((item, index) => (
          <div
            key={item.id}
            className="send-queue-row"
            draggable
            data-dragging={draggingId === item.id || undefined}
            onDragStart={(event) => {
              dragIdRef.current = item.id
              setDraggingId(item.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(event) => {
              event.preventDefault()
              const dragId = dragIdRef.current
              if (!dragId || dragId === item.id) return
              const order = chat.sendQueue.map((entry) => entry.id)
              const from = order.indexOf(dragId)
              const to = order.indexOf(item.id)
              if (from < 0 || to < 0) return
              order.splice(to, 0, ...order.splice(from, 1))
              stream.queueReorder(order)
            }}
            onDragEnd={() => {
              dragIdRef.current = undefined
              setDraggingId(undefined)
            }}
          >
            <HolderOutlined className="send-queue-handle" />
            <span className="send-queue-text" title={item.text}>
              {index + 1}. {item.text}
            </span>
            <Tooltip title="移出队列">
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                aria-label="移出队列"
                onClick={() => stream.queueRemove(item.id)}
              />
            </Tooltip>
          </div>
        ))}
      </div>
    ) : null

  // 中断提示上的「重试」：重发最后一条已收口的 user 消息（乐观回显不重发；
  // 纯图消息 chip 剥离后 text 为空，没有可重发的文本，不出现按钮）。
  const retryLast = useCallback(() => {
    const last = [...chat.messages]
      .reverse()
      .find((message) => message.role === 'user' && !message.local && message.text.trim())
    if (last) void send(last.text)
  }, [chat.messages, send])

  const canRetryLast = chat.messages.some(
    (message) => message.role === 'user' && !message.local && !!message.text.trim(),
  )

  const decide = useCallback(
    async (kind: string) => {
      if (!chat.permission) return
      try {
        await api.decidePermission(chat.permission.id, kind)
      } catch (cause) {
        stream.setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, chat.permission, stream],
  )

  // AskUserQuestion 作答：value 缺省 = 跳过（模型收到「未作答」并自选默认继续）。
  const answerAsk = useCallback(
    async (value?: string) => {
      if (!chat.ask) return
      try {
        await api.answerAsk(chat.ask.id, value)
      } catch (cause) {
        stream.setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [api, chat.ask, stream],
  )

  // 自由文本回答：不选选项、直接键入答案原样透传（工具侧 User answered 语义）。
  const [askDraft, setAskDraft] = useState('')
  const askId = chat.ask?.id
  useEffect(() => {
    setAskDraft('')
  }, [askId])
  const sendAskFreeText = useCallback(() => {
    const text = askDraft.trim()
    if (!text || !chat.ask) return
    setAskDraft('')
    void answerAsk(text)
  }, [askDraft, chat.ask, answerAsk])

  const end = useCallback(async () => {
    setBusy(true)
    try {
      await api.endSession()
      onSessionChange(undefined)
      onSessionsChanged()
    } finally {
      setBusy(false)
    }
  }, [api, onSessionChange, onSessionsChanged])

  const running = chat.turn === 'running'
  const lastMessage = chat.messages.at(-1)
  const streamingReply = lastMessage?.role === 'assistant' && lastMessage.streaming === true
  // 状态行（对齐 TUI StreamingStatus：动词 · 秒数 · ↑ tokens · 中断）：
  // 阶段取最后一个运行中的工具卡（无则在思考/等待模型）；tokens ≈ chars/4。
  const runningTool = running ? chat.tools.findLast((tool) => tool.status === 'running') : undefined
  const runningToolLabel = runningTool
    ? runningTool.tool === 'Task'
      ? '子代理'
      : toolLabel(runningTool.tool)
    : undefined
  const streamedTokens = Math.round(chat.streamedChars / 4)
  const canSend =
    !busy && !running && (draft.trim().length > 0 || images.some((item) => item.status === 'ready'))

  // 会话流混排：消息与工具卡按到达 seq 合并渲染——工具卡跟随其发生的时点，
  // 不再整体沉到消息流末尾（多回合/中途工具调用的时序靠它保住）。
  // 连续 ≥2 的工具行再折成一个「N 次工具调用」分组（展开才是逐行卡）。
  const feed = chatFeedGrouped(chat)

  // 「已思考」摘要行的插入点：最后一个 user 消息之后的首条 assistant（即本回合回复）。
  const lastUserIndex = chat.messages.findLastIndex((message) => message.role === 'user')
  const turnReplyId = chat.messages.find(
    (message, index) => index > lastUserIndex && message.role === 'assistant',
  )?.id
  const showTurnStats = turnStats !== undefined && turnReplyId !== undefined && !running

  /** 时间分隔行挂哪条消息（id）：按混排序相邻消息间隔超阈值才再出一次（对齐 IM 惯例）。 */
  const timeBreaks = new Set<string>()
  let lastShownAt = 0
  for (const entry of feed) {
    if (entry.kind !== 'message') continue
    const at = entry.message.at
    if (at === undefined) continue
    if (at - lastShownAt > TIME_GAP_MS) {
      timeBreaks.add(entry.message.id)
      lastShownAt = at
    }
  }

  const renderMessage = (message: ChatMessage) => {
    const at = message.at
    const timeRow = timeBreaks.has(message.id) && at !== undefined && (
      <div key={`${message.id}-time`} className="msg-time">
        {formatHHMM(at)}
      </div>
    )
    const statsRow = message.id === turnReplyId && showTurnStats && turnStats !== undefined && (
      <div key={`${message.id}-stats`} className="think-row settled">
        已思考 · {turnStats.seconds} 秒 · {turnStats.steps} 个步骤
      </div>
    )
    if (message.role === 'user')
      return [
        timeRow,
        <div key={message.id} className="msg-row user">
          <div className="msg-bubble">
            {message.images?.map((image) => {
              const src = chatImageSrc(image)
              if (!src) return null
              return <img key={image.chip} className="msg-image" src={src} alt={image.chip} />
            })}
            {message.text}
          </div>
        </div>,
      ]
    if (message.role === 'system')
      return [
        timeRow,
        <div key={message.id} className="msg-row system">
          {message.text}
        </div>,
      ]
    return [
      timeRow,
      statsRow,
      <div key={message.id} className="msg-row asst">
        <Markdown text={message.text} />
        {message.streaming && <TypingDots />}
      </div>,
    ]
  }

  /** 最近会话条目的时间副标：今天 HH:MM，更早 M月D日 HH:MM。 */
  const recentTimeLabel = (updatedAt: string): string => {
    const time = Date.parse(updatedAt)
    if (Number.isNaN(time)) return ''
    const date = new Date(time)
    const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    const today = date.toDateString() === new Date().toDateString()
    return today ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  }

  // 最近会话弹层（对齐 CodeBuddy web：标题带项目名 + X；空态；底部管理入口）。
  const recentPanel = (
    <div className="recent-panel">
      <div className="recent-head">
        <Typography.Text strong>最近会话 · {projectName}</Typography.Text>
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          onClick={() => setRecentOpen(false)}
        />
      </div>
      <div className="recent-body">
        {recentSessions.length === 0 ? (
          <div className="recent-empty">
            <HistoryOutlined style={{ fontSize: 32 }} />
            <Typography.Text strong>没有历史对话</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前项目还没有可继续的对话
            </Typography.Text>
          </div>
        ) : (
          recentSessions.map((session) => (
            <div
              key={session.id}
              className="recent-item"
              onClick={() => {
                setRecentOpen(false)
                onResumeSession(session.id)
              }}
            >
              <Typography.Text strong ellipsis style={{ display: 'block', fontSize: 13 }}>
                {session.title}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {recentTimeLabel(session.updatedAt)}
              </Typography.Text>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        className="recent-footer"
        onClick={() => {
          setRecentOpen(false)
          onFocusSessionSearch()
        }}
      >
        <SearchOutlined style={{ marginRight: 8 }} />
        搜索并管理全部对话
      </button>
    </div>
  )

  // ── composer 卡片（欢迎屏与会话底栏共用同一节点结构）─────────────────────
  const composer = (
    <div
      className={`composer${dragOver ? ' composer-drag' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        if (event.dataTransfer.files.length > 0) addImages(event.dataTransfer.files)
      }}
      onClick={() => textareaRef.current?.focus()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) addImages(event.target.files)
          event.target.value = ''
        }}
      />
      <div className="composer-chips">
        <span className="composer-chip" title={cwd}>
          <FolderOutlined />
          {projectName}
        </span>
      </div>
      {images.length > 0 && (
        <div className="composer-thumbs">
          {images.map((image, index) => (
            <span
              key={image.chip}
              className={`composer-thumb${image.status === 'error' ? ' error' : ''}`}
            >
              <img src={image.previewUrl} alt={image.chip} />
              {image.status === 'uploading' && (
                <span className="composer-thumb-mask">
                  <LoadingOutlined />
                </span>
              )}
              <button
                type="button"
                className="composer-thumb-x"
                aria-label={`移除 ${image.chip}`}
                onClick={(event) => {
                  event.stopPropagation()
                  setImages((current) => current.filter((_, i) => i !== index))
                }}
              >
                <CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* W-05：@-mention / slash 补全面板（textarea 上方绝对定位） */}
      {mentionOpen && (
        <div className="composer-popup" role="listbox" aria-label="文件引用候选">
          {mentionList.map((candidate, index) => (
            <button
              key={candidate.path}
              type="button"
              role="option"
              aria-selected={index === (mention?.active ?? 0)}
              className={`composer-popup-item${index === (mention?.active ?? 0) ? ' active' : ''}`}
              onClick={() => void attachFileCandidate(candidate.path)}
            >
              📄 {candidate.path}
            </button>
          ))}
        </div>
      )}
      {!mentionOpen && slashOpen && (
        <div className="composer-popup" role="listbox" aria-label="命令候选">
          {slashList.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === slashActive}
              className={`composer-popup-item${index === slashActive ? ' active' : ''}`}
              onClick={() => {
                setDraft('')
                void command.run({
                  hasActiveSession: sessionId !== undefined,
                  interrupt: () => void api.interrupt().catch(() => {}),
                  endSession: () => {
                    void api
                      .endSession()
                      .then(() => onSessionChange(undefined))
                      .catch(() => {})
                  },
                  notice: (value) => stream.setNotice(value),
                })
              }}
            >
              /{command.name}
              <span style={{ marginLeft: 8, opacity: 0.6 }}>{command.description}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        value={draft}
        placeholder={
          busy && sessionId === undefined
            ? '正在创建会话…'
            : '给智能体发消息（Enter 发送，Shift+Enter 换行）'
        }
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value)
          textareaSelectionRef.current = event.target.selectionStart
          // 打字复位历史浏览态（保留 entries）。
          setInputHistory((current) => resetHistoryNavigation(current))
          // @ 触发：光标处命中 mention 语义 → 打开面板并防抖拉取文件快照。
          const query = mentionQueryAt(event.target.value, event.target.selectionStart)
          if (query !== undefined && query.query.length >= 1) {
            setMention((current) => ({
              query: query.query,
              files: current?.files ?? [],
              active: 0,
            }))
            if (fileQueryTimer.current) clearTimeout(fileQueryTimer.current)
            fileQueryTimer.current = setTimeout(() => {
              void api.listSessionFiles().then((files) => {
                setMention((current) => (current ? { ...current, files } : current))
              })
            }, 200)
          } else if (query === undefined) {
            setMention(undefined)
          }
        }}
        onKeyDown={onTextareaKeyDown}
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) {
            event.preventDefault()
            addImages(event.clipboardData.files)
          }
        }}
        onClick={(event) => event.stopPropagation()}
      />
      <div className="composer-bar">
        <Tooltip title="添加图片">
          <button
            type="button"
            className="composer-btn"
            aria-label="添加图片"
            onClick={(event) => {
              event.stopPropagation()
              fileInputRef.current?.click()
            }}
          >
            <PlusOutlined />
          </button>
        </Tooltip>
        {chat.permissionMode !== undefined && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: PERMISSION_MODES.map((mode) => ({
                key: mode.id,
                label: (
                  <div className="perm-mode-item">
                    <span
                      className={`perm-mode-check${mode.id === chat.permissionMode ? ' on' : ''}`}
                    >
                      {mode.id === chat.permissionMode ? <CheckOutlined /> : null}
                    </span>
                    <span className="perm-mode-text">
                      <span className="perm-mode-label">{mode.label}</span>
                      <span className="perm-mode-desc">{mode.desc}</span>
                    </span>
                  </div>
                ),
              })),
              selectedKeys: [chat.permissionMode],
              onClick: ({ key }) => {
                void api
                  .setPermissionMode(key)
                  .then((result) => stream.setPermissionMode(result.mode))
              },
            }}
          >
            <button
              type="button"
              className="composer-btn text"
              onClick={(e) => e.stopPropagation()}
            >
              <SafetyCertificateOutlined />
              {PERMISSION_MODES.find((mode) => mode.id === chat.permissionMode)?.label ?? '询问'}
              <DownOutlined className="composer-caret" />
            </button>
          </Dropdown>
        )}
        <span style={{ flex: 1 }} />
        {models && models.options.length > 0 && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: models.options.map((option) => ({ key: option.id, label: option.label })),
              selectedKeys: [modelOverride ?? models.current ?? ''],
              onClick: ({ key }) => setModelOverride(key === models.current ? undefined : key),
            }}
          >
            <button
              type="button"
              className="composer-btn text"
              onClick={(e) => e.stopPropagation()}
            >
              {models.options.find((option) => option.id === (modelOverride ?? models.current))
                ?.label ?? '模型'}
              <DownOutlined className="composer-caret" />
            </button>
          </Dropdown>
        )}
        {running && <LoadingOutlined className="composer-spin" />}
        <Tooltip title={running ? '中断本轮' : '发送'}>
          <button
            type="button"
            className={`composer-send${running ? ' stop' : ''}`}
            aria-label={running ? '中断本轮' : '发送'}
            disabled={!running && !canSend}
            onClick={(event) => {
              event.stopPropagation()
              if (running) void api.interrupt()
              else void send(draft)
            }}
          >
            {running ? <StopOutlined /> : <ArrowUpOutlined />}
          </button>
        </Tooltip>
      </div>
    </div>
  )

  const empty = chat.messages.length === 0
  const headerStatus = !connected ? '离线' : running ? '运行中' : '空闲'

  return (
    <div className="chat-wrap">
      {/* 顶栏：左留白 / 居中标题+副标 / 右侧图标按钮（对齐 CodeBuddy 会话头）。 */}
      <div className="chat-head">
        <div className="chat-head-side" />
        {!empty && (
          <div className="chat-head-center">
            <div className="chat-head-title">{sessionTitle ?? '新对话'}</div>
            <div className="chat-head-sub">
              {projectName} · 主智能体 · {headerStatus}
            </div>
          </div>
        )}
        <div className="chat-head-side actions">
          <Tooltip title="在当前智能体中新建对话">
            <Button
              size="small"
              type="text"
              icon={<NewChatIcon />}
              disabled={sessionId === undefined && chat.messages.length === 0}
              onClick={() => onSessionChange(undefined)}
            />
          </Tooltip>
          <Popover
            open={recentOpen}
            onOpenChange={setRecentOpen}
            trigger="click"
            placement="bottomRight"
            arrow={false}
            classNames={{ root: 'recent-popover' }}
            content={recentPanel}
          >
            <Tooltip title="最近会话 (⌘⇧H)">
              <Button
                size="small"
                type={recentOpen ? 'primary' : 'text'}
                icon={<HistoryOutlined />}
              />
            </Tooltip>
          </Popover>
          <Tooltip title="工作台">
            <Button
              size="small"
              type={workbenchOpen ? 'primary' : 'text'}
              icon={<WorkbenchIcon />}
              onClick={onToggleWorkbench}
            />
          </Tooltip>
          <Tooltip title="连接面板">
            <Button
              size="small"
              type={connectOpen ? 'primary' : 'text'}
              icon={<LinkOutlined />}
              onClick={onToggleConnect}
            />
          </Tooltip>
          {sessionId !== undefined && !embedded && (
            <Button size="small" onClick={() => void end()} disabled={busy}>
              结束会话
            </Button>
          )}
        </div>
      </div>

      {empty ? (
        /* 欢迎屏：品牌标 + 标语 + cwd + composer 卡片垂直居中。 */
        <div className="chat-hero">
          <BrandMark size={84} />
          <div className="chat-hero-tag">锻造灵感 · 化为现实</div>
          <div className="chat-hero-cwd">{cwd}</div>
          <div className="chat-hero-composer">
            {queueBlock}
            {composer}
          </div>
          {chat.notice && (
            <Alert type="warning" showIcon title={chat.notice} style={{ marginTop: 12 }} />
          )}
        </div>
      ) : (
        <div className="chat-column">
          {/* 消息流 */}
          <div
            className="chat-scroll"
            ref={listRef}
            onScroll={() => {
              const el = listRef.current
              if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="chat-disclaimer">回答由 AI 生成，仅供参考</div>
            {feed.map((entry) =>
              entry.kind === 'tool' ? (
                <ToolRowCard key={entry.key} tool={entry.tool} subagents={chat.subagents} />
              ) : entry.kind === 'tool-group' ? (
                <ToolGroupCard key={entry.key} tools={entry.tools} subagents={chat.subagents} />
              ) : (
                renderMessage(entry.message)
              ),
            )}
            {running && !streamingReply && (
              <div className="think-row">
                <TypingDots />
                <span>
                  {runningTool ? `运行 ${runningToolLabel}` : elapsed < 2 ? '准备中' : '思考中'}
                  {elapsed >= 2 ? ` · ${elapsed}s` : ''}
                  {streamedTokens > 0 ? ` · ↑ ${streamedTokens} tokens` : ''}
                </span>
              </div>
            )}
            {chat.permission && (
              <div className="perm-card">
                <Typography.Text strong>
                  权限请求：{chat.permission.display.toolName}
                </Typography.Text>
                <PermissionLineageBadge lineage={chat.permission.lineage} />
                <pre className="perm-spec">{chat.permission.display.spec}</pre>
                <div className="perm-actions">
                  {chat.permission.display.approvable ? (
                    <>
                      <Button size="small" type="primary" onClick={() => void decide('allow-once')}>
                        允许一次
                      </Button>
                      <Button size="small" onClick={() => void decide('allow-session')}>
                        本会话允许
                      </Button>
                      {chat.permission.mcpServer && (
                        <Tooltip
                          title={`本会话内放行 MCP server「${chat.permission.mcpServer}」的全部工具`}
                        >
                          <Button size="small" onClick={() => void decide('allow-mcp-server')}>
                            允许此 server 全部工具
                          </Button>
                        </Tooltip>
                      )}
                    </>
                  ) : null}
                  <Button size="small" type="primary" danger onClick={() => void decide('deny')}>
                    拒绝
                  </Button>
                </div>
              </div>
            )}
            {chat.ask && (
              <div className="perm-card ask-card">
                <Typography.Text strong>提问：{chat.ask.question}</Typography.Text>
                <div className="ask-options">
                  {chat.ask.options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className="ask-option"
                      onClick={() => void answerAsk(option.label)}
                    >
                      <span className="ask-option-label">{option.label}</span>
                      {option.description ? (
                        <span className="ask-option-desc">{option.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
                <div className="ask-free">
                  <Input
                    size="small"
                    placeholder="自定义回答（不选选项）"
                    aria-label="自定义回答"
                    value={askDraft}
                    onChange={(event) => setAskDraft(event.target.value)}
                    onPressEnter={sendAskFreeText}
                  />
                  <Tooltip title="发送自定义回答">
                    <Button
                      size="small"
                      type="text"
                      aria-label="发送自定义回答"
                      icon={<SendOutlined />}
                      disabled={!askDraft.trim()}
                      onClick={sendAskFreeText}
                    />
                  </Tooltip>
                </div>
                <div className="perm-actions">
                  <Button size="small" type="text" onClick={() => void answerAsk()}>
                    跳过（不作答）
                  </Button>
                </div>
              </div>
            )}
            {/* 用户主动中断：弱化为灰字 + 重试（不是报错，不进黄色警示条）。 */}
            {chat.interrupted && (
              <div className="chat-interrupted">
                <span>已中断本次回复</span>
                {canRetryLast && (
                  <Button
                    type="link"
                    size="small"
                    style={{ padding: 0, height: 'auto' }}
                    disabled={busy || chat.turn === 'running'}
                    onClick={retryLast}
                  >
                    重试
                  </Button>
                )}
              </div>
            )}
            {chat.notice && (
              <Alert type="warning" showIcon title={chat.notice} style={{ margin: '8px 0' }} />
            )}
            {chat.usage && (
              <div className="chat-usage">
                用量：in {chat.usage.input} / out {chat.usage.output}
                {chat.usage.costUSD ? ` · $${chat.usage.costUSD.toFixed(4)}` : ''}
              </div>
            )}
            {/* 会话文件变更卡片：钉在消息流末尾，turn 边沿刷新；审查/打开落工作台。 */}
            <ChangesCard
              api={api}
              sessionId={sessionId}
              turn={chat.turn}
              onOpenChanges={onOpenChanges}
              onOpenFile={onOpenFile}
            />
          </div>

          {/* composer */}
          <div className="chat-composer">
            {queueBlock}
            {composer}
          </div>
        </div>
      )}
    </div>
  )
}
