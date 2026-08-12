import { Box, Text, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { MemoryPanelController, MemoryPanelMode, MemoryPanelRecord } from '../memory-panel'
import { memoryPanelError, truncateTerminal, wrapTerminalLines } from '../memory-panel'
import { PanelFrame } from './PanelFrame'

const PAGE_SIZE = 8
const SEARCH_DELAY_MS = 300

interface EditorState {
  content: string
  field: 'content' | 'tags'
  originalContent: string
  originalTags: readonly string[]
  tags: string
}

export interface MemoryPanelProps {
  controller: MemoryPanelController
  noColor?: boolean
  paused?: boolean
  terminalColumns: number
  terminalRows: number
  onClose(): void
}

export function MemoryPanel({
  controller,
  noColor = false,
  paused = false,
  terminalColumns,
  terminalRows,
  onClose,
}: MemoryPanelProps) {
  const [mode, setMode] = useState<MemoryPanelMode>('loading')
  const [items, setItems] = useState<readonly MemoryPanelRecord[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [nextCursor, setNextCursor] = useState<string>()
  const [error, setError] = useState<string>()
  const [editor, setEditor] = useState<EditorState>()
  const [confirmDelete, setConfirmDelete] = useState<'cancel' | 'delete'>('cancel')
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [detailScroll, setDetailScroll] = useState(0)
  const generation = useRef(0)
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  )
  const selected = items[selectedIndex]
  const width = Math.max(30, terminalColumns - 4)
  const detailViewport = Math.max(3, terminalRows - 14)
  const detailLineCount = wrapTerminalLines(selected?.content ?? '', width).length

  const applyItems = useCallback(
    (
      next: readonly MemoryPanelRecord[],
      preferredId?: string,
      emptyMode: 'empty' | 'noMatch' = 'empty',
    ) => {
      setItems(next)
      const id =
        preferredId && next.some((item) => item.id === preferredId) ? preferredId : next[0]?.id
      setSelectedId(id)
      setMode(next.length ? 'list' : emptyMode)
    },
    [],
  )

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const currentGeneration = ++generation.current
      setError(undefined)
      setMode(cursor ? 'mutating' : 'loading')
      try {
        const page = await controller.list({
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        })
        if (generation.current !== currentGeneration) return
        const next = append ? [...items, ...page.items] : page.items
        setNextCursor(page.nextCursor)
        applyItems(next, selectedId)
      } catch (cause) {
        if (generation.current !== currentGeneration) return
        setError(memoryPanelError(cause).message)
        setMode(cursor && items.length ? 'list' : 'loadError')
      }
    },
    [applyItems, controller, items, selectedId],
  )

  useEffect(() => {
    void load()
    return () => {
      generation.current++
    }
  }, [controller])

  useEffect(() => {
    if (!query) return
    if (!controller.searchAvailable) {
      setError('Search is unavailable in this session.')
      setMode('searchError')
      return
    }
    const currentGeneration = ++generation.current
    const abort = new AbortController()
    setError(undefined)
    setMode('searching')
    const timer = setTimeout(() => {
      void controller
        .search({ query, limit: 100, signal: abort.signal })
        .then((records) => {
          if (generation.current !== currentGeneration || abort.signal.aborted) return
          setNextCursor(undefined)
          setItems(records)
          setSelectedId((current) =>
            current && records.some((record) => record.id === current) ? current : records[0]?.id,
          )
          setMode(records.length ? 'list' : 'noMatch')
        })
        .catch((cause) => {
          if (generation.current !== currentGeneration || abort.signal.aborted) return
          setError(memoryPanelError(cause).message)
          setMode('searchError')
        })
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [controller, query, retryGeneration])

  const selectIndex = useCallback(
    (index: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, index))]
      if (next) setSelectedId(next.id)
    },
    [items],
  )

  const openDetail = useCallback(async () => {
    if (!selected) return
    const currentGeneration = ++generation.current
    setMode('loading')
    try {
      const record = await controller.get(selected.id)
      if (generation.current !== currentGeneration) return
      if (!record)
        throw Object.assign(new Error('Memory was not found.'), { code: 'memory_not_found' })
      setItems((current) => current.map((item) => (item.id === record.id ? record : item)))
      setSelectedId(record.id)
      setDetailScroll(0)
      setMode('detail')
    } catch (cause) {
      if (generation.current !== currentGeneration) return
      setError(memoryPanelError(cause).message)
      setMode('loadError')
    }
  }, [controller, selected])

  const beginEdit = useCallback(() => {
    if (!selected) return
    setEditor({
      content: selected.content,
      field: 'content',
      originalContent: selected.content,
      originalTags: selected.tags,
      tags: selected.tags.join(', '),
    })
    setError(undefined)
    setMode('edit')
  }, [selected])

  const replaceRecord = useCallback((record: MemoryPanelRecord) => {
    setItems((current) => current.map((item) => (item.id === record.id ? record : item)))
    setSelectedId(record.id)
  }, [])

  const mutatePin = useCallback(async () => {
    if (!selected) return
    setMode('mutating')
    setError(undefined)
    try {
      const record = selected.pinned
        ? await controller.unpin(selected.id, selected.updatedAt)
        : await controller.pin(selected.id, selected.updatedAt)
      replaceRecord(record)
      await load()
    } catch (cause) {
      const mapped = memoryPanelError(cause)
      setError(mapped.code === 'memory_scope_denied' ? 'Permission denied.' : mapped.message)
      setMode('detail')
    }
  }, [controller, load, replaceRecord, selected])

  const saveEdit = useCallback(async () => {
    if (!selected || !editor) return
    setMode('mutating')
    setError(undefined)
    try {
      const record = await controller.update(
        selected.id,
        {
          content: editor.content,
          tags: editor.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
        selected.updatedAt,
      )
      replaceRecord(record)
      setEditor(undefined)
      setMode('detail')
    } catch (cause) {
      const mapped = memoryPanelError(cause)
      setError(mapped.code === 'memory_scope_denied' ? 'Permission denied.' : mapped.message)
      setMode(mapped.code === 'memory_conflict' ? 'conflict' : 'edit')
    }
  }, [controller, editor, replaceRecord, selected])

  const deleteSelected = useCallback(async () => {
    if (!selected) return
    const oldIndex = selectedIndex
    setMode('mutating')
    setError(undefined)
    try {
      await controller.delete(selected.id, selected.updatedAt)
      const remaining = items.filter((item) => item.id !== selected.id)
      setItems(remaining)
      setSelectedId(remaining[Math.min(oldIndex, remaining.length - 1)]?.id)
      setMode(remaining.length ? 'list' : 'empty')
    } catch (cause) {
      const mapped = memoryPanelError(cause)
      setError(mapped.code === 'memory_scope_denied' ? 'Permission denied.' : mapped.message)
      setMode(mapped.code === 'memory_conflict' ? 'conflict' : 'detail')
    }
  }, [controller, items, selected, selectedIndex])

  const clearSearch = useCallback(() => {
    generation.current++
    setQuery('')
    setSearchFocused(false)
    void load()
  }, [load])

  useInput(
    (input, key) => {
      if (paused) return
      if (mode === 'loading' || mode === 'mutating') return
      if (mode === 'loadError' || mode === 'searchError') {
        if (key.escape) {
          if (query) clearSearch()
          else onClose()
        } else if (input.toLowerCase() === 'r') {
          if (query) setRetryGeneration((current) => current + 1)
          else void load()
        }
        return
      }
      if (mode === 'discardEdit') {
        if (key.escape || input.toLowerCase() === 'c') setMode('edit')
        else if (input.toLowerCase() === 'd') {
          setEditor(undefined)
          setMode('detail')
        }
        return
      }
      if (mode === 'confirmDelete') {
        if (key.escape) {
          setConfirmDelete('cancel')
          setMode('detail')
        } else if (key.tab || key.leftArrow || key.rightArrow) {
          setConfirmDelete((current) => (current === 'cancel' ? 'delete' : 'cancel'))
        } else if (key.return) {
          if (confirmDelete === 'delete') void deleteSelected()
          else setMode('detail')
        }
        return
      }
      if (mode === 'conflict') {
        if (input.toLowerCase() === 'r' && selected) {
          void controller
            .get(selected.id)
            .then((record) => {
              if (!record) return
              replaceRecord(record)
              setEditor(undefined)
              setError(undefined)
              setMode('detail')
            })
            .catch((cause) => setError(memoryPanelError(cause).message))
        } else if (key.escape) setMode(editor ? 'edit' : 'detail')
        return
      }
      if (mode === 'edit' && editor) {
        if ((key.ctrl && input.toLowerCase() === 's') || input === '\u0013') {
          void saveEdit()
          return
        }
        if (key.escape) {
          const dirty =
            editor.content !== editor.originalContent ||
            editor.tags !== editor.originalTags.join(', ')
          setMode(dirty ? 'discardEdit' : 'detail')
          return
        }
        if (key.tab) {
          setEditor((current) =>
            current
              ? { ...current, field: current.field === 'content' ? 'tags' : 'content' }
              : current,
          )
          return
        }
        if (key.backspace || key.delete) {
          setEditor((current) =>
            current
              ? { ...current, [current.field]: current[current.field].slice(0, -1) }
              : current,
          )
          return
        }
        if (!key.ctrl && !key.meta && input)
          setEditor((current) =>
            current ? { ...current, [current.field]: current[current.field] + input } : current,
          )
        return
      }
      if (mode === 'detail') {
        if (key.escape) {
          setDetailScroll(0)
          setMode(items.length ? 'list' : 'empty')
        } else if (key.upArrow) setDetailScroll((current) => Math.max(0, current - 1))
        else if (key.downArrow)
          setDetailScroll((current) =>
            Math.min(Math.max(0, detailLineCount - detailViewport), current + 1),
          )
        else if (key.pageUp) setDetailScroll((current) => Math.max(0, current - detailViewport))
        else if (key.pageDown)
          setDetailScroll((current) =>
            Math.min(Math.max(0, detailLineCount - detailViewport), current + detailViewport),
          )
        else if (input.toLowerCase() === 'e') beginEdit()
        else if (input.toLowerCase() === 'p') void mutatePin()
        else if (input.toLowerCase() === 'd') {
          setConfirmDelete('cancel')
          setMode('confirmDelete')
        }
        return
      }
      if (searchFocused) {
        if (key.escape) {
          if (query) clearSearch()
          else {
            setSearchFocused(false)
            onClose()
          }
        } else if (key.upArrow || key.downArrow) {
          setSearchFocused(false)
          selectIndex(selectedIndex + (key.upArrow ? -1 : 1))
        } else if (key.backspace || key.delete) setQuery((current) => current.slice(0, -1))
        else if (!key.ctrl && !key.meta && input) setQuery((current) => current + input)
        return
      }
      if (key.escape) onClose()
      else if (input === '/') setSearchFocused(true)
      else if (key.upArrow) selectIndex(selectedIndex - 1)
      else if (key.downArrow) selectIndex(selectedIndex + 1)
      else if (key.pageUp) selectIndex(selectedIndex - PAGE_SIZE)
      else if (key.pageDown) {
        if (selectedIndex + PAGE_SIZE < items.length) selectIndex(selectedIndex + PAGE_SIZE)
        else if (nextCursor && !query) void load(nextCursor, true)
        else selectIndex(items.length - 1)
      } else if (key.home) selectIndex(0)
      else if (key.end) selectIndex(items.length - 1)
      else if (key.return) void openDetail()
      else if (input.toLowerCase() === 'e') beginEdit()
      else if (input.toLowerCase() === 'p') void mutatePin()
      else if (input.toLowerCase() === 'd') {
        setConfirmDelete('cancel')
        setMode('confirmDelete')
      }
    },
    { isActive: !paused },
  )

  const visibleRows = Math.max(3, Math.min(PAGE_SIZE, terminalRows - 12))
  const pageStart = Math.floor(selectedIndex / visibleRows) * visibleRows
  const visibleItems = items.slice(pageStart, pageStart + visibleRows)
  const footer = footerFor(mode, searchFocused, nextCursor, error)
  const title = `Memory · ${controller.scopeLabel}`

  return (
    <PanelFrame footer={footer} title={title}>
      <SearchBand focused={searchFocused} query={query} unavailable={!controller.searchAvailable} />
      {mode === 'loading' ? <Text>Loading…</Text> : null}
      {mode === 'searching' ? <Text>Searching…</Text> : null}
      {mode === 'mutating' ? <Text>Saving…</Text> : null}
      {mode === 'loadError' || mode === 'searchError' ? (
        <Text {...(!noColor ? { color: 'red' as const } : {})}>Error: {error}</Text>
      ) : null}
      {mode === 'empty' ? <Text>No memories in this scope. Esc closes.</Text> : null}
      {mode === 'noMatch' ? <Text>No memories match “{query}”. Esc clears search.</Text> : null}
      {mode === 'list' || mode === 'searchError' ? (
        <MemoryList
          items={visibleItems}
          noColor={noColor}
          {...(selectedId ? { selectedId } : {})}
          width={width}
        />
      ) : null}
      {selected && ['detail', 'confirmDelete', 'conflict', 'discardEdit', 'edit'].includes(mode) ? (
        <MemoryDetail
          {...(editor ? { editor } : {})}
          {...(error ? { error } : {})}
          mode={mode}
          noColor={noColor}
          record={selected}
          scroll={detailScroll}
          viewport={detailViewport}
          width={width}
        />
      ) : null}
      {mode === 'confirmDelete' && selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...(!noColor ? { color: 'red' as const } : {})}>
            Delete this memory from {selected.scope}? This cannot be undone from the panel.
          </Text>
          <Text>
            {confirmDelete === 'cancel' ? '> ' : '  '}Cancel {'  '}
            {confirmDelete === 'delete' ? '> ' : '  '}Delete
          </Text>
        </Box>
      ) : null}
      {mode === 'discardEdit' ? (
        <Text>Modified draft. [C] Continue editing (default) · [D] Discard · Esc continue</Text>
      ) : null}
      {mode === 'conflict' ? (
        <Box flexDirection="column">
          <Text {...(!noColor ? { color: 'red' as const } : {})}>
            Error: Memory changed concurrently.
          </Text>
          <Text>Your draft is retained above. [R] Reload stored value · Esc return to draft</Text>
        </Box>
      ) : null}
    </PanelFrame>
  )
}

function SearchBand(props: { focused: boolean; query: string; unavailable: boolean }) {
  return (
    <Box marginBottom={1}>
      <Text>{props.focused ? '> ' : '  '}Search: </Text>
      <Text>{props.query || (props.unavailable ? 'unavailable' : 'press /')}</Text>
    </Box>
  )
}

function MemoryList(props: {
  items: readonly MemoryPanelRecord[]
  noColor: boolean
  selectedId?: string
  width: number
}) {
  return (
    <Box flexDirection="column">
      {props.items.map((record) => {
        const selected = record.id === props.selectedId
        const prefix = `${selected ? '> ' : '  '}${record.pinned ? '[P]' : '[ ]'} `
        const metadata = `${record.tags.join(', ') || 'no tags'} · ${record.scope} · ${formatRelative(record.updatedAt)}`
        return (
          <Box flexDirection="column" key={record.id}>
            <Text {...(selected && !props.noColor ? { color: 'cyan' as const } : {})}>
              {prefix}
              {truncateTerminal(record.content, Math.max(10, props.width - prefix.length))}
            </Text>
            {props.width >= 56 ? (
              <Text {...(!props.noColor ? { color: 'gray' as const } : {})}>
                {'      '}
                {truncateTerminal(metadata, props.width - 6)}
              </Text>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

function MemoryDetail(props: {
  editor?: EditorState
  error?: string
  mode: MemoryPanelMode
  noColor: boolean
  record: MemoryPanelRecord
  scroll: number
  viewport: number
  width: number
}) {
  const editing = props.mode === 'edit' || props.mode === 'discardEdit' || props.mode === 'conflict'
  const content = editing && props.editor ? props.editor.content : props.record.content
  const tags = editing && props.editor ? props.editor.tags : props.record.tags.join(', ')
  const contentLines = wrapTerminalLines(content, props.width)
  const visibleContent = editing
    ? contentLines
    : contentLines.slice(props.scroll, props.scroll + props.viewport)
  return (
    <Box flexDirection="column">
      <Text bold>
        {props.record.pinned ? '[P] ' : ''}
        {props.record.id}
      </Text>
      <Text>{visibleContent.join('\n')}</Text>
      {!editing && contentLines.length > props.viewport ? (
        <Text>
          Lines {props.scroll + 1}–{Math.min(contentLines.length, props.scroll + props.viewport)} of{' '}
          {contentLines.length} · ↑/↓ scroll
        </Text>
      ) : null}
      <Text>
        Tags: {tags || 'none'}
        {editing && props.editor?.field === 'tags' ? ' ▌' : ''}
      </Text>
      <Text>
        Scope: {props.record.scope} · Source: {props.record.source}
        {props.record.actor ? ` (${props.record.actor})` : ''}
      </Text>
      <Text>
        Created: {props.record.createdAt} · Updated: {props.record.updatedAt}
      </Text>
      {editing ? (
        <Text>
          Modified{props.editor?.field === 'content' ? ' content ▌' : ''} · Tab field · Ctrl+S save
          · Esc back
        </Text>
      ) : null}
      {props.error && props.mode !== 'conflict' ? (
        <Text {...(!props.noColor ? { color: 'red' as const } : {})}>Error: {props.error}</Text>
      ) : null}
    </Box>
  )
}

function footerFor(
  mode: MemoryPanelMode,
  searchFocused: boolean,
  nextCursor: string | undefined,
  error: string | undefined,
): string {
  if (mode === 'loadError' || mode === 'searchError')
    return `Error: ${error ?? 'unknown'} · R retry · Esc back`
  if (mode === 'detail') return 'Esc list · E edit · P pin/unpin · D delete'
  if (mode === 'edit') return 'Tab field · Ctrl+S save · Esc back'
  if (searchFocused) return 'Type to search · ↑/↓ results · Esc clear/close'
  return `↑/↓ select · PgUp/PgDn page${nextCursor ? '+' : ''} · Enter detail · / search · E edit · P pin · D delete · Esc close`
}

function formatRelative(value: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
