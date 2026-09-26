import type { AskPromptController, InteractiveAskRequest } from '@volund/app-runtime'
import { Box, Text, useInput } from 'ink'
import { useEffect, useState } from 'react'

export interface AskPromptStackProps {
  controller: AskPromptController
  asks: readonly InteractiveAskRequest[]
}

const MAX_QUESTION_ROWS = 6
const QUESTION_ROW_WIDTH = 88
const MAX_TAB_LABEL = 14

/** 问题文本按终端宽度硬折行（模型产出可能很长；单行 truncate 会吞掉选项）。 */
function wrapQuestion(question: string, width: number): string[] {
  const rows: string[] = []
  for (const sourceLine of question.split('\n')) {
    let current = ''
    for (const word of sourceLine.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (candidate.length > width && current) {
        rows.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    rows.push(current)
  }
  return rows
}

/**
 * AskUserQuestion 的多请求提问卡（TUI 端）：与 PermissionPromptStack 同款交互
 * 范式——↑↓ 移动焦点、Enter 确认、数字键直选、esc 关闭（不作答）。多个提问
 * 并存时（并行工具调用）按 tab 条切换；作答后 controller 出队，全端清卡。
 */
export function AskPromptStack({ controller, asks }: AskPromptStackProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [optionIndex, setOptionIndex] = useState(0)
  const ask = asks[Math.min(activeIndex, asks.length - 1)]

  // 作答/他端作答后出队：钳住焦点，tab 跟着剩队走。
  useEffect(() => {
    if (activeIndex > asks.length - 1) setActiveIndex(Math.max(0, asks.length - 1))
  }, [activeIndex, asks.length])
  useEffect(() => {
    const count = ask?.options.length ?? 0
    if (optionIndex > count - 1) setOptionIndex(Math.max(0, count - 1))
  }, [optionIndex, ask])

  useInput(
    (input, key) => {
      if (!ask) return
      if (key.escape) {
        controller.decide(ask.id, undefined)
        return
      }
      const switchTab =
        key.tab || key.leftArrow || key.rightArrow
          ? key.leftArrow || (key.shift && key.tab)
            ? -1
            : 1
          : 0
      if (switchTab !== 0 && asks.length > 1) {
        setActiveIndex((activeIndex + switchTab + asks.length) % asks.length)
        setOptionIndex(0)
        return
      }
      if (key.upArrow || key.downArrow) {
        const step = key.downArrow ? 1 : -1
        setOptionIndex((current) => (current + step + ask.options.length) % ask.options.length)
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const option = ask.options[optionIndex]
        if (option) controller.decide(ask.id, option.label)
        return
      }
      const numbered = /^[1-9]$/.test(input) ? ask.options[Number(input) - 1] : undefined
      if (numbered) controller.decide(ask.id, numbered.label)
    },
    { isActive: Boolean(ask) },
  )

  if (!ask) return null
  const questionRows = wrapQuestion(ask.question, QUESTION_ROW_WIDTH).slice(0, MAX_QUESTION_ROWS)
  const hiddenRows = wrapQuestion(ask.question, QUESTION_ROW_WIDTH).length - questionRows.length

  return (
    <Box
      borderColor="gray"
      borderStyle="round"
      flexDirection="column"
      marginBottom={1}
      paddingX={2}
      paddingY={0}
    >
      <Box marginTop={1}>
        <Text bold color="cyan">
          ◆ 提问
        </Text>
        {asks.length > 1 ? (
          <Text color="gray">
            {' '}
            · {activeIndex + 1}/{asks.length}
          </Text>
        ) : null}
      </Box>
      {asks.length > 1 ? (
        <Box marginTop={1}>
          {asks.map((entry, index) => {
            const label = ` ${index + 1}:${entry.question.length > MAX_TAB_LABEL ? `${entry.question.slice(0, MAX_TAB_LABEL - 1)}…` : entry.question} `
            if (index === activeIndex)
              return (
                <Text backgroundColor="cyan" bold color="black" key={entry.id}>
                  {label}
                </Text>
              )
            return (
              <Text color="gray" key={entry.id}>
                {label}
              </Text>
            )
          })}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {questionRows.map((row, index) => (
          <Text key={`q:${index}`} wrap="truncate">
            {row}
          </Text>
        ))}
        {hiddenRows > 0 ? <Text color="gray">…</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {ask.options.map((option, index) => {
          const focused = index === optionIndex
          return (
            <Text key={option.label} wrap="truncate">
              {focused ? (
                <Text bold color="cyan" key="ptr">
                  {'> '}
                </Text>
              ) : (
                '  '
              )}
              <Text bold={focused} color={focused ? 'cyan' : 'gray'} key="num">
                {index + 1}
              </Text>
              {'  '}
              <Text
                bold={focused}
                key="lbl"
                {...(focused ? { color: 'cyan' } : { color: 'white' })}
              >
                {option.label}
              </Text>
              {option.description ? (
                <Text color="gray" key="desc">
                  {'  '}
                  {option.description}
                </Text>
              ) : null}
            </Text>
          )
        })}
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">
          ↑↓ 选择 · enter 确认 · 数字键直选{asks.length > 1 ? ' · ←/→ 切换提问' : ''} · esc 跳过
        </Text>
      </Box>
    </Box>
  )
}
