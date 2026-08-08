import { Box, Text, useInput, useStdout } from 'ink'
import { useMemo, useState } from 'react'

import type { StatusPanelController, StatusPanelData, StatusTabId, StatusValue } from '../status'
import { validateStatusConfigValue } from '../status'
import { PanelFrame } from './PanelFrame'
import { TabBar } from './TabBar'

export interface StatusPanelProps {
  controller?: StatusPanelController
  data: StatusPanelData
  onClose?: () => void
}

const tabs = [
  { id: 'settings', label: 'Settings' },
  { id: 'status', label: 'Status' },
  { id: 'config', label: 'Config' },
] as const

export function StatusPanel({ controller, data: initialData, onClose }: StatusPanelProps) {
  const [data, setData] = useState(initialData)
  const [active, setActive] = useState<StatusTabId>('status')
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<{ id: string; value: string }>()
  const [message, setMessage] = useState('Tab/←/→ switch  ↑/↓ move  Enter edit  Esc close')
  const { stdout } = useStdout()
  const rows = active === 'config' ? data.config : data[active]
  const height = Math.max(3, Math.min(12, (stdout.rows ?? 24) - 10))
  const offset = Math.max(0, Math.min(selected - height + 1, rows.length - height))
  const visible = rows.slice(offset, offset + height)

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(undefined)
        setMessage('Edit cancelled')
        return
      }
      if (key.return) {
        const item = data.config.find((candidate) => candidate.id === editing.id)
        if (item) void save(item, item.kind === 'number' ? Number(editing.value) : editing.value)
        return
      }
      if (key.backspace || key.delete) setEditing({ ...editing, value: editing.value.slice(0, -1) })
      else if (input && !key.ctrl && !key.meta)
        setEditing({ ...editing, value: editing.value + input })
      return
    }
    if (key.escape) return onClose?.()
    if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1
      setSelected((value) => Math.max(0, Math.min(rows.length - 1, value + step)))
      return
    }
    if (key.return && active === 'config') void editSelected(data.config[selected])

    async function editSelected(item = data.config[selected]) {
      if (!item) return
      if (!item.editable) return setMessage(item.readonlyReason ?? `${item.label} is read-only`)
      if (!controller) return setMessage('Configuration persistence is not available')
      if (item.kind === 'string') {
        setEditing({ id: item.id, value: String(item.value) })
        setMessage(`Editing ${item.label}: type, Enter save, Esc cancel`)
        return
      }
      try {
        const value = nextValue(item, input)
        await save(item, value)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Unable to save configuration')
      }
    }

    async function save(item: StatusPanelData['config'][number], value: StatusValue) {
      try {
        validateStatusConfigValue(item, value)
        setData(await controller!.update(item.id, value))
        setEditing(undefined)
        setMessage(`${item.label} saved`)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Unable to save configuration')
      }
    }
  })

  const renderedRows = useMemo(
    () => visible.map((row, index) => ({ row, selected: offset + index === selected })),
    [offset, selected, visible],
  )
  return (
    <PanelFrame footer={message} title="> /status">
      <TabBar
        activeId={active}
        onActiveChange={(id) => {
          setActive(id as StatusTabId)
          setSelected(0)
        }}
        tabs={tabs}
      />
      <Box flexDirection="column" minHeight={height}>
        {renderedRows.map(({ row, selected: isSelected }) => (
          <Box key={'id' in row ? row.id : row.label}>
            <Text {...(isSelected ? { color: 'cyan' } : {})}>{isSelected ? '› ' : '  '}</Text>
            <Box width={24}>
              <Text bold={isSelected}>{row.label}</Text>
            </Box>
            <Text
              {...('editable' in row && !row.editable ? { color: 'gray' } : {})}
              wrap="truncate-end"
            >
              {String(row.value)}
              {'editable' in row ? (row.editable ? '  [editable]' : '  [read-only]') : ''}
            </Text>
          </Box>
        ))}
      </Box>
      {editing ? <Text color="cyan">Value: {editing.value}▌</Text> : null}
      {rows.length > height ? (
        <Text dimColor>
          {offset + 1}–{Math.min(offset + height, rows.length)} / {rows.length}
        </Text>
      ) : null}
    </PanelFrame>
  )
}

function nextValue(item: StatusPanelData['config'][number], typed: string): StatusValue {
  if (item.kind === 'boolean') return !item.value
  if (item.kind === 'enum') {
    const choices = item.choices ?? []
    return choices[(choices.indexOf(String(item.value)) + 1) % choices.length] ?? item.value
  }
  if (item.kind === 'number') return Math.min(item.max ?? Infinity, Number(item.value) + 1)
  return typed.trim() || item.value
}
