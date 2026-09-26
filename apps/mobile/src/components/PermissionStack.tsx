'use client'

/**
 * 审批队列卡（移动端）：一键决策面——每个档位都是一个直接生效的按钮
 * （与 TUI 单键决策、Web 一键按钮同语义；点即发送 permission.decide，
 * 不再有「先选作用域再点批准」的两段式）。
 * - 多请求 tab：待审批队列 >1 时顶部 tab 切换（与 TUI PermissionPromptStack 同语义）；
 * - 能力行直读「写入 /path」而不是裸 JSON；完整美化 JSON 收进「详情」折叠；
 * - 七档决策：主操作 允许本次/拒绝 + 次要档位行（本会话/项目/永久/全放行/永不），
 *   kind 经 gateway permission.decide 原样透传（与 TUI 同一决策面）；
 * - 在途反馈：点过的档位转圈并锁全部按钮，队列投影变化（resolved/下一请求）即解锁，
 *   超时兜底解锁防卡死；
 * - 不可审批（display.approvable=false）：细节不可安全展示，仅可拒绝（fail closed）。
 */
import { LoadingOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'

import type { PermissionCard } from '../lib/chat'
import { parsePermissionDisplaySpec, type PermissionSpecLine } from '../lib/permission-spec'
import { PermissionLineageBadge } from './PermissionLineageBadge'

/** 主操作（大按钮，一键生效）。 */
const PRIMARY_ACTIONS = [
  { kind: 'allow-once', label: '允许本次', tone: 'approve' },
  { kind: 'deny', label: '拒绝', tone: 'deny' },
] as const

/** 次要档位（小 pill，同样一键生效）：放行族在前，危险档靠后。 */
const SECONDARY_ACTIONS = [
  { kind: 'allow-session', label: '本会话', tone: 'allow' },
  { kind: 'allow-project', label: '项目', tone: 'allow' },
  { kind: 'allow-forever', label: '永久', tone: 'allow' },
  { kind: 'allow-all-session', label: '全放行', tone: 'warn' },
  { kind: 'deny-forever', label: '永不', tone: 'deny' },
] as const

/** spec 能力行的色调（write/run 提示副作用）。 */
const SPEC_LINE_TONE: Record<PermissionSpecLine['kind'], string> = {
  read: 'tone-read',
  write: 'tone-write',
  run: 'tone-write',
  net: 'tone-read',
  env: 'tone-env',
  custom: 'tone-env',
}

/** JSON 语法高亮的逐 token 扫描（key/string/字面量/数字），匹配不到的原样输出。 */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function highlightJson(code: string) {
  const nodes: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let seq = 0
  while ((match = JSON_TOKEN.exec(code)) !== null) {
    if (match.index > last) nodes.push(code.slice(last, match.index))
    const [text, str, colon, literal, num] = match
    if (str !== undefined) {
      nodes.push(
        <span key={`t${seq++}`} className={colon ? 'json-key' : 'json-str'}>
          {str}
        </span>,
      )
      if (colon) nodes.push(colon)
    } else if (literal !== undefined) {
      nodes.push(
        <span key={`t${seq++}`} className="json-lit">
          {literal}
        </span>,
      )
    } else if (num !== undefined) {
      nodes.push(
        <span key={`t${seq++}`} className="json-num">
          {num}
        </span>,
      )
    } else {
      nodes.push(text)
    }
    last = match.index + text.length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return nodes
}

/** 能力值 → 首行 + 续行（多行命令/多路径按 TUI 卡面的 `│` 续行样式展开）。 */
function SpecValueRows({ line }: { line: PermissionSpecLine }) {
  const fragments = line.value.split('\n')
  return (
    <>
      {fragments.map((fragment, index) =>
        fragment.length === 0 && index > 0 ? null : (
          <div key={index} className={`perm-spec-row ${SPEC_LINE_TONE[line.kind]}`}>
            <span className="perm-spec-gutter">{index === 0 ? line.label : '│'}</span>
            <span className="perm-spec-value">{fragment}</span>
          </div>
        ),
      )}
    </>
  )
}

/** 审批倒计时文案：剩余秒数；归零后到局前（网关 deny → resolved 清卡）的过渡文案。 */
function countdownLabel(expiresAt: number, now: number): string {
  const remaining = Math.round((expiresAt - now) / 1000)
  if (remaining <= 0) return '自动拒绝中…'
  return `${remaining}s 后自动拒绝`
}

export function PermissionStack({
  permissions,
  onDecide,
}: {
  permissions: readonly PermissionCard[]
  onDecide(requestId: string, kind: string): void
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  /** 在途决策（点过的档位）：锁全部按钮直到了局投影变化；超时兜底解锁。 */
  const [pendingKind, setPendingKind] = useState<string | undefined>()
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // 审批倒计时：网关到点自动 deny（时钟权威在网关，expiresAt 由帧盖章下发），
  // 本地每秒重算剩余；无一帧带截止（旧网关）时不起表。
  const [now, setNow] = useState(() => Date.now())
  const hasDeadline = permissions.some((entry) => entry.expiresAt !== undefined)
  useEffect(() => {
    if (!hasDeadline) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [hasDeadline])

  // 队列收缩（本端或他端决策）时钳住焦点，tab 跟着剩队走。
  useEffect(() => {
    if (activeIndex > permissions.length - 1) setActiveIndex(Math.max(0, permissions.length - 1))
  }, [activeIndex, permissions.length])

  // 队列投影变化（决策被接受/他端处理/新请求进来）= 在途态解除。
  useEffect(() => {
    setPendingKind(undefined)
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
  }, [permissions])

  // 兜底：应答/事件丢失（弱网）时 8s 解锁，卡片不永久失效。
  useEffect(() => {
    if (!pendingKind) return
    pendingTimerRef.current = setTimeout(() => setPendingKind(undefined), 8_000)
    return () => clearTimeout(pendingTimerRef.current)
  }, [pendingKind])

  if (permissions.length === 0) return null
  const request = permissions[Math.min(activeIndex, permissions.length - 1)]!
  const spec = parsePermissionDisplaySpec(request.display.approvable, request.display.spec)

  const decide = (kind: string) => {
    if (pendingKind) return
    setPendingKind(kind)
    onDecide(request.id, kind)
  }

  const decideButton = (kind: string, label: string, className: string): React.ReactNode => (
    <button
      key={kind}
      type="button"
      className={className}
      data-kind={kind}
      disabled={pendingKind !== undefined}
      onClick={() => decide(kind)}
    >
      {pendingKind === kind && <LoadingOutlined style={{ fontSize: 12, marginRight: 5 }} />}
      {label}
    </button>
  )

  return (
    <section className="permstack" aria-label="权限请求">
      <div className="perm-head">
        <span className="perm-pulse" aria-hidden />
        <span className="perm-title">权限请求</span>
        <span className="perm-tool">{request.display.toolName}</span>
        <PermissionLineageBadge lineage={request.lineage} />
        {request.expiresAt !== undefined && (
          <span className="perm-countdown">{countdownLabel(request.expiresAt, now)}</span>
        )}
        {permissions.length > 1 && (
          <span className="perm-count">
            {activeIndex + 1}/{permissions.length}
          </span>
        )}
      </div>

      {permissions.length > 1 && (
        <div className="perm-reqtabs" role="tablist" aria-label="待审批队列">
          {permissions.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-request-tab={entry.display.toolName}
              data-active={index === activeIndex || undefined}
              aria-selected={index === activeIndex}
              className="perm-reqtab"
              onClick={() => setActiveIndex(index)}
            >
              {index + 1}·{entry.display.toolName}
            </button>
          ))}
        </div>
      )}

      <div className="perm-body">
        {spec.lines.length > 0 ? (
          <div className="perm-spec">
            {spec.lines.map((line, index) => (
              <SpecValueRows key={index} line={line} />
            ))}
          </div>
        ) : (
          <div className="perm-raw">{request.display.spec}</div>
        )}
        {spec.pretty !== undefined && (
          <details className="perm-details">
            <summary>详情</summary>
            <pre className="perm-json">{highlightJson(spec.pretty)}</pre>
          </details>
        )}
      </div>

      {request.display.approvable ? (
        <>
          <div className="perm-actions">
            {PRIMARY_ACTIONS.map((action) =>
              decideButton(
                action.kind,
                action.label,
                action.tone === 'approve' ? 'perm-approve' : 'perm-deny',
              ),
            )}
          </div>
          <div className="perm-pills">
            {SECONDARY_ACTIONS.map((action) =>
              decideButton(action.kind, action.label, `perm-pill tone-${action.tone}`),
            )}
          </div>
        </>
      ) : (
        <>
          <div className="perm-denonly-hint">该请求细节无法安全展示，仅可拒绝（fail closed）</div>
          <div className="perm-actions">
            {decideButton('deny', '拒绝', 'perm-deny perm-deny-wide')}
            {decideButton('deny-forever', '永不询问', 'perm-pill tone-deny perm-pill-standalone')}
          </div>
        </>
      )}
    </section>
  )
}
