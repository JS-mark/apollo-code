import { Box, Text, useInput } from 'ink'
import { useMemo } from 'react'

export interface TabItem {
  disabled?: boolean
  id: string
  label: string
}

export interface TabBarProps {
  activeId: string
  onActiveChange?: (id: string) => void
  tabs: readonly TabItem[]
}

export function TabBar({ activeId, onActiveChange, tabs }: TabBarProps) {
  const enabledTabs = useMemo(() => tabs.filter((tab) => !tab.disabled), [tabs])

  useInput((input, key) => {
    const backwards = key.shift && key.tab
    const forwards = key.tab || key.rightArrow
    const left = key.leftArrow
    if (!backwards && !forwards && !left) return
    const nextId = nextEnabledTabId(enabledTabs, activeId, backwards || left ? -1 : 1)
    if (nextId) onActiveChange?.(nextId)
  })

  return (
    <Box>
      {tabs.map((tab, index) => {
        const active = tab.id === activeId
        const content = `${active ? `[${tab.label}]` : ` ${tab.label} `}${
          index < tabs.length - 1 ? '  ' : ''
        }`
        if (tab.disabled)
          return (
            <Text color="gray" key={tab.id}>
              {content}
            </Text>
          )
        if (active)
          return (
            <Text inverse key={tab.id}>
              {content}
            </Text>
          )
        return <Text key={tab.id}>{content}</Text>
      })}
    </Box>
  )
}

function nextEnabledTabId(tabs: readonly TabItem[], activeId: string, step: 1 | -1) {
  if (tabs.length === 0) return undefined
  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  )
  for (let offset = 1; offset <= tabs.length; offset += 1) {
    const index = (currentIndex + offset * step + tabs.length) % tabs.length
    const tab = tabs[index]
    if (tab) return tab.id
  }
  return undefined
}
