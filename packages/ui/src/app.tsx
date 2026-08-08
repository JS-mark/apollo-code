import type { CoreEvent, EventBus } from '@apollo-code/core'
import { Box } from 'ink'
import { useEffect, useMemo, useState } from 'react'

import { InputBox } from './components/InputBox'
import { ScrollableTranscript } from './components/ScrollableTranscript'
import { StatusLine, type StatusLevel } from './components/StatusLine'
import { TopBar } from './components/TopBar'

export interface TranscriptEntry {
  id: string
  role: 'assistant' | 'system' | 'user'
  text: string
}

export interface SlashCommandInput {
  name: string
  args: readonly string[]
  raw: string
}

export interface SlashCommand {
  name: string
  description: string
  aliases?: readonly string[]
  available?: boolean
  run(input: SlashCommandInput): Promise<void> | void
}

export interface InputHistoryStore {
  append(input: string): Promise<void> | void
  list(): Promise<readonly string[]> | readonly string[]
}

export interface InteractiveAppOptions {
  cwd: string
  events?: EventBus
  history?: InputHistoryStore
  initialInput?: string
  sessionId?: string
  slashCommands?: readonly SlashCommand[]
  status?: string
}

interface InteractiveAppState {
  pendingAssistantText: string
  sessionId: string
  status: string
  statusLevel: StatusLevel
  transcript: TranscriptEntry[]
}

export function InteractiveApp(options: InteractiveAppOptions) {
  const [state, setState] = useState<InteractiveAppState>(() => ({
    pendingAssistantText: '',
    sessionId: options.sessionId ?? 'new',
    status: options.status ?? 'ready',
    statusLevel: 'muted',
    transcript: [],
  }))

  useEffect(() => {
    if (!options.events) return
    return options.events.subscribe((event) => {
      setState((current) => applyInteractiveEvent(current, event))
    })
  }, [options.events])

  const transcript = useMemo(() => {
    if (!state.pendingAssistantText) return state.transcript
    return [
      ...state.transcript,
      { id: 'pending-assistant', role: 'assistant' as const, text: state.pendingAssistantText },
    ]
  }, [state.pendingAssistantText, state.transcript])

  return (
    <Box flexDirection="column">
      <TopBar cwd={options.cwd} sessionId={state.sessionId} status={state.status} />
      <ScrollableTranscript entries={transcript} />
      <StatusLine level={state.statusLevel}>{state.status}</StatusLine>
      <InputBox value={options.initialInput ?? ''} />
    </Box>
  )
}

function applyInteractiveEvent(state: InteractiveAppState, event: CoreEvent): InteractiveAppState {
  if (event.type === 'session.started') {
    return {
      ...state,
      sessionId: event.sessionId,
      status: 'session started',
      statusLevel: 'muted',
    }
  }

  if (event.type === 'message.appended') {
    const text = payloadText(event.payload)
    if (!text) return state
    return {
      ...state,
      transcript: [...state.transcript, { id: event.id, role: payloadRole(event.payload), text }],
    }
  }

  if (event.type === 'stream.started') {
    return { ...state, pendingAssistantText: '', status: 'streaming', statusLevel: 'active' }
  }

  if (event.type === 'stream.delta') {
    return {
      ...state,
      pendingAssistantText: state.pendingAssistantText + payloadText(event.payload),
      status: 'streaming',
      statusLevel: 'active',
    }
  }

  if (event.type === 'stream.completed') {
    if (!state.pendingAssistantText) return { ...state, status: 'ready', statusLevel: 'muted' }
    return {
      ...state,
      pendingAssistantText: '',
      status: 'ready',
      statusLevel: 'muted',
      transcript: [
        ...state.transcript,
        { id: event.id, role: 'assistant', text: state.pendingAssistantText },
      ],
    }
  }

  if (event.type === 'turn.aborted') {
    return { ...state, status: 'turn aborted', statusLevel: 'warning' }
  }

  if (event.type === 'error.raised') {
    return {
      ...state,
      status: payloadText(event.payload) || 'error',
      statusLevel: 'error',
    }
  }

  if (event.type === 'session.ended') {
    return { ...state, status: 'session ended', statusLevel: 'muted' }
  }

  return state
}

function payloadText(payload: CoreEvent['payload']): string {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''

  const objectPayload = payload as Record<string, unknown>
  const chunk = objectPayload.chunk
  if (chunk && typeof chunk === 'object' && !Array.isArray(chunk)) {
    const chunkText = (chunk as Record<string, unknown>).text
    if (typeof chunkText === 'string') return chunkText
  }

  for (const key of ['text', 'content', 'message']) {
    const value = objectPayload[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function payloadRole(payload: CoreEvent['payload']): TranscriptEntry['role'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'system'
  const role = (payload as Record<string, unknown>).role
  return role === 'assistant' || role === 'user' || role === 'system' ? role : 'system'
}
