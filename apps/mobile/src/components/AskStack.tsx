'use client'

/**
 * 提问队列卡（移动端）：AskUserQuestion 工具的作答面——每个选项都是一个
 * 直接生效的按钮（与审批卡一键决策同语义；点即发送 ask.answer）。
 * - 多提问 tab：队列 >1 时顶部 tab 切换（与审批卡同范式）；
 * - 选项行：label 主文案 + description 次要说明（模型给的后果注释）；
 * - 在途反馈：点过的选项转圈并锁全部按钮，队列投影变化即解锁，超时兜底；
 * - 「跳过」= 不作答关闭（value 缺省出站，模型自选默认继续）。
 */
import { LoadingOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'

import type { AskCard } from '../lib/chat'

export function AskStack({
  asks,
  onAnswer,
}: {
  asks: readonly AskCard[]
  onAnswer(requestId: string, value?: string): void
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  /** 在途作答（点过的选项）：锁全部按钮直到队列投影变化；超时兜底解锁。 */
  const [pendingValue, setPendingValue] = useState<string | undefined>()
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 队列收缩（本端或他端作答）时钳住焦点，tab 跟着剩队走。
  useEffect(() => {
    if (activeIndex > asks.length - 1) setActiveIndex(Math.max(0, asks.length - 1))
  }, [activeIndex, asks.length])

  // 队列投影变化（作答被接受/他端处理/新提问进来）= 在途态解除。
  useEffect(() => {
    setPendingValue(undefined)
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
  }, [asks])

  // 兜底：应答/事件丢失（弱网）时 8s 解锁，卡片不永久失效。
  useEffect(() => {
    if (pendingValue === undefined) return
    pendingTimerRef.current = setTimeout(() => setPendingValue(undefined), 8_000)
    return () => clearTimeout(pendingTimerRef.current)
  }, [pendingValue])

  if (asks.length === 0) return null
  const ask = asks[Math.min(activeIndex, asks.length - 1)]!

  const answer = (value?: string) => {
    if (pendingValue !== undefined) return
    setPendingValue(value ?? '')
    onAnswer(ask.id, value)
  }

  return (
    <section className="permstack askstack" aria-label="提问">
      <div className="perm-head">
        <span className="perm-pulse" aria-hidden />
        <span className="perm-title">提问</span>
        {asks.length > 1 && (
          <span className="perm-count">
            {activeIndex + 1}/{asks.length}
          </span>
        )}
      </div>

      {asks.length > 1 && (
        <div className="perm-reqtabs" role="tablist" aria-label="待决提问队列">
          {asks.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-request-tab={entry.question}
              data-active={index === activeIndex || undefined}
              aria-selected={index === activeIndex}
              className="perm-reqtab"
              onClick={() => setActiveIndex(index)}
            >
              {index + 1}·
              {entry.question.length > 14 ? `${entry.question.slice(0, 13)}…` : entry.question}
            </button>
          ))}
        </div>
      )}

      <div className="askstack-question">{ask.question}</div>

      <div className="askstack-options">
        {ask.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="askstack-option"
            data-option={option.label}
            disabled={pendingValue !== undefined}
            onClick={() => answer(option.label)}
          >
            {pendingValue === option.label && (
              <LoadingOutlined style={{ fontSize: 12, marginRight: 5 }} />
            )}
            <span className="askstack-option-label">{option.label}</span>
            {option.description && (
              <span className="askstack-option-desc">{option.description}</span>
            )}
          </button>
        ))}
      </div>

      <div className="perm-actions">
        <button
          type="button"
          className="perm-pill tone-env askstack-skip"
          disabled={pendingValue !== undefined}
          onClick={() => answer(undefined)}
        >
          跳过（不作答）
        </button>
      </div>
    </section>
  )
}
