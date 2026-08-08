import type { CoreEvent, EventBus } from '@apollo-code/core'
import { Box, useApp } from 'ink'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { InputBox } from './components/InputBox'
import { ModelPicker } from './components/ModelPicker'
import { PermissionPromptStack } from './components/PermissionPromptStack'
import { ScrollableTranscript } from './components/ScrollableTranscript'
import { StatusLine, type StatusLevel } from './components/StatusLine'
import { TopBar } from './components/TopBar'
import { WelcomePanel } from './components/WelcomePanel'
import { useSessionEvents } from './hooks/useSessionEvents'
import { useStreamBuffer } from './hooks/useStreamBuffer'
import type { ModelPickerState, SubmitOptions } from './model-picker'
import type { PermissionPromptController } from './permission'
import type { WelcomePanelData } from './welcome'

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
  modelPicker?: ModelPickerState
  onExit?: () => Promise<void> | void
  onModelSelect?: (model: string) => Promise<void> | void
  onSubmit?: (input: string, options?: SubmitOptions) => Promise<void> | void
  permissions?: PermissionPromptController
  sessionId?: string
  slashCommands?: readonly SlashCommand[]
  status?: string
  welcome?: WelcomePanelData
}

interface InteractiveAppState {
  pendingAssistantText: string
  sessionId: string
  status: string
  statusLevel: StatusLevel
  transcript: TranscriptEntry[]
}

export function InteractiveApp(options: InteractiveAppOptions) {
  const { exit } = useApp()
  const [state, setState] = useState<InteractiveAppState>(() => ({
    pendingAssistantText: '',
    sessionId: options.sessionId ?? 'new',
    status: options.status ?? 'ready',
    statusLevel: 'muted',
    transcript: [],
  }))
  const [historyEntries, setHistoryEntries] = useState<readonly string[]>([])
  const [showWelcome, setShowWelcome] = useState(Boolean(options.welcome))
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [currentModelId, setCurrentModelId] = useState(options.modelPicker?.currentModelId ?? '')
  const [activeModelId, setActiveModelId] = useState(options.modelPicker?.currentModelId ?? '')
  const [permissionRequests, setPermissionRequests] = useState(
    () => options.permissions?.requests() ?? [],
  )

  const flushPendingToTranscript = useCallback(
    (state: InteractiveAppState, id: string): InteractiveAppState => {
      if (!state.pendingAssistantText) return state
      return {
        ...state,
        pendingAssistantText: '',
        transcript: [
          ...state.transcript,
          { id, role: 'assistant', text: state.pendingAssistantText },
        ],
      }
    },
    [],
  )

  const streamBuffer = useStreamBuffer(
    useCallback((text) => {
      setState((current) => ({
        ...current,
        pendingAssistantText: current.pendingAssistantText + text,
      }))
    }, []),
  )

  useEffect(() => {
    if (!options.permissions) return
    return options.permissions.subscribe(setPermissionRequests)
  }, [options.permissions])

  useSessionEvents(
    options.events,
    useCallback(
      (event) => {
        if (event.type === 'stream.started') {
          streamBuffer.reset()
          setShowWelcome(false)
          setState((current) => applyInteractiveEvent(current, event))
          return
        }
        if (event.type === 'stream.delta') {
          streamBuffer.append(payloadText(event.payload))
          setState((current) => ({ ...current, status: 'streaming', statusLevel: 'active' }))
          return
        }
        if (event.type === 'stream.completed') {
          const flushed = streamBuffer.flushNow()
          setState((current) => {
            const withFlushed = flushed
              ? {
                  ...current,
                  pendingAssistantText: current.pendingAssistantText + flushed,
                }
              : current
            return applyInteractiveEvent(withFlushed, event)
          })
          return
        }
        if (event.type === 'turn.aborted' || event.type === 'error.raised') {
          const flushed = streamBuffer.flushNow()
          setState((current) => {
            const withFlushed = flushed
              ? {
                  ...current,
                  pendingAssistantText: current.pendingAssistantText + flushed,
                }
              : current
            return applyInteractiveEvent(flushPendingToTranscript(withFlushed, event.id), event)
          })
          return
        }
        if (event.type === 'tool.started') setShowWelcome(false)
        setState((current) => applyInteractiveEvent(current, event))
      },
      [flushPendingToTranscript, streamBuffer],
    ),
  )

  useEffect(() => {
    let disposed = false
    void Promise.resolve(options.history?.list() ?? []).then(
      (items) => {
        if (!disposed) setHistoryEntries(items)
      },
      () => {
        if (!disposed)
          setState((current) => ({
            ...current,
            status: 'history unavailable',
            statusLevel: 'warning',
          }))
      },
    )
    return () => {
      disposed = true
    }
  }, [options.history])

  const slashCommands = useMemo(() => {
    if (options.slashCommands) return options.slashCommands
    const hasModelPicker = Boolean(options.modelPicker?.models.length)
    const commands: SlashCommand[] = [
      {
        name: 'help',
        description: 'Show slash commands',
        run: () => {
          setShowWelcome(false)
          appendSystemMessage(setState, slashHelpText(commands))
        },
      },
      {
        name: 'exit',
        description: 'End the session',
        run: async () => {
          await options.onExit?.()
          exit()
        },
      },
      {
        name: 'clear',
        description: 'Clear the transcript',
        run: () => {
          setShowWelcome(false)
          setState((current) => ({ ...current, transcript: [], pendingAssistantText: '' }))
        },
      },
      unavailableSlashCommand('context', 'Show context status'),
      unavailableSlashCommand('compact', 'Compact conversation context'),
      hasModelPicker
        ? {
            name: 'model',
            description: 'Switch model',
            run: () => {
              setShowWelcome(false)
              setModelPickerOpen(true)
              setActiveModelId(currentModelId || firstAvailableModelId(options.modelPicker!.models))
              setState((current) => ({
                ...current,
                status: 'select model',
                statusLevel: 'muted',
              }))
            },
          }
        : unavailableSlashCommand('model', 'Switch model'),
    ]
    return commands
  }, [currentModelId, exit, options.modelPicker, options.onExit, options.slashCommands])

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
      {showWelcome && options.welcome ? <WelcomePanel data={options.welcome} /> : null}
      {modelPickerOpen && options.modelPicker ? (
        <ModelPicker
          activeId={activeModelId}
          currentModelId={currentModelId}
          models={options.modelPicker.models}
          onActiveChange={setActiveModelId}
          onCancel={() => {
            setModelPickerOpen(false)
            setState((current) => ({ ...current, status: 'model selection cancelled' }))
          }}
          onSubmit={async (id) => {
            const model = options.modelPicker?.models.find((item) => item.id === id)
            if (!model || model.disabled) return
            setCurrentModelId(model.id)
            setActiveModelId(model.id)
            setModelPickerOpen(false)
            await options.onModelSelect?.(`${model.provider}/${model.model}`)
            appendSystemMessage(setState, `Model set to ${model.label}`)
            setState((current) => ({ ...current, status: `model ${model.label}` }))
          }}
        />
      ) : null}
      <ScrollableTranscript entries={transcript} />
      {options.permissions ? (
        <PermissionPromptStack controller={options.permissions} requests={permissionRequests} />
      ) : null}
      <StatusLine level={permissionRequests.length > 0 ? 'warning' : state.statusLevel}>
        {permissionRequests.length > 0 ? 'permission required' : state.status}
      </StatusLine>
      <InputBox
        disabled={
          modelPickerOpen || state.statusLevel === 'active' || permissionRequests.length > 0
        }
        history={historyEntries}
        initialValue={options.initialInput ?? ''}
        slashCommands={slashCommands}
        onSubmit={async (input) => {
          const trimmed = input.trim()
          if (!trimmed) return
          if (trimmed === 'exit' || trimmed === 'quit') {
            await options.onExit?.()
            exit()
            return
          }
          if (trimmed.startsWith('/')) {
            setShowWelcome(false)
            const message = await runSlashCommand(trimmed, slashCommands)
            if (message) {
              appendSystemMessage(setState, message)
              setState((current) => ({ ...current, status: message, statusLevel: 'warning' }))
            }
            return
          }
          setShowWelcome(false)
          try {
            await options.history?.append(input)
            setHistoryEntries(await Promise.resolve(options.history?.list() ?? []))
          } catch {
            setState((current) => ({
              ...current,
              status: 'history unavailable',
              statusLevel: 'warning',
            }))
          }
          await options.onSubmit?.(input, submitOptions(currentModelId))
        }}
      />
    </Box>
  )
}

function firstAvailableModelId(models: readonly ModelPickerState['models'][number][]) {
  return models.find((model) => !model.disabled)?.id ?? models[0]?.id ?? ''
}

function submitOptions(currentModelId: string): SubmitOptions | undefined {
  if (!currentModelId) return undefined
  return { model: currentModelId }
}

function appendSystemMessage(
  setState: Dispatch<SetStateAction<InteractiveAppState>>,
  text: string,
) {
  setState((current) => ({
    ...current,
    transcript: [
      ...current.transcript,
      {
        id: `system-${Date.now()}`,
        role: 'system',
        text,
      },
    ],
  }))
}

function unavailableSlashCommand(name: string, description: string): SlashCommand {
  return {
    name,
    description,
    available: false,
    run: () => {},
  }
}

export async function runSlashCommand(raw: string, commands: readonly SlashCommand[]) {
  const [name = '', ...args] = raw.slice(1).trim().split(/\s+/).filter(Boolean)
  if (!name) return undefined
  const command = commands.find((item) => item.name === name || item.aliases?.includes(name))
  if (!command) return `Unknown slash command: /${name}`
  if (command.available === false) return `/${command.name} is not available in this build/session`
  try {
    await command.run({ args, name: command.name, raw })
  } catch (error) {
    return error instanceof Error ? error.message : `/${command.name} failed`
  }
  return undefined
}

function slashHelpText(commands: readonly SlashCommand[]) {
  return commands
    .map((command) => {
      const suffix = command.available === false ? ' (not available in this build/session)' : ''
      return `/${command.name} - ${command.description}${suffix}`
    })
    .join('\n')
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

  if (event.type === 'turn.completed') {
    return { ...state, status: 'ready', statusLevel: 'muted' }
  }

  if (event.type === 'tool.permission_asked') {
    return { ...state, status: 'permission required', statusLevel: 'warning' }
  }

  if (event.type === 'tool.started') {
    const toolName = payloadField(event.payload, 'toolName') || 'tool'
    return { ...state, status: `running ${toolName}`, statusLevel: 'active' }
  }

  if (event.type === 'tool.completed') {
    const toolName = payloadField(event.payload, 'toolName') || 'tool'
    return { ...state, status: `${toolName} completed`, statusLevel: 'muted' }
  }

  if (event.type === 'context.compacted') {
    return { ...state, status: 'context compacted', statusLevel: 'muted' }
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

function payloadField(payload: CoreEvent['payload'], key: string): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
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
