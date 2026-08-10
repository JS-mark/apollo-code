import { render, type RenderOptions } from 'ink'
import { createElement } from 'react'

import { InteractiveApp, type InteractiveAppOptions } from './app'
import {
  DirectoryTrustPrompt,
  type DirectoryTrustDecision,
} from './components/DirectoryTrustPrompt'
import { SessionPicker } from './components/SessionPicker'
import type { SessionCandidate } from './session-picker'

export interface InteractiveAppHandle {
  clear(): void
  unmount(): void
  waitUntilRenderFlush(): Promise<void>
  waitUntilExit(): Promise<void>
}

export function renderSessionPicker(input: {
  sessions: readonly SessionCandidate[]
  error?: string
}): Promise<SessionCandidate | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: SessionCandidate) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(value)
    }
    const instance = render(
      createElement(SessionPicker, {
        ...input,
        onCancel: () => finish(),
        onSelect: finish,
      }),
      { exitOnCtrlC: false },
    )
  })
}

export function renderInteractiveApp(
  options: InteractiveAppOptions,
  renderOptions?: RenderOptions,
): InteractiveAppHandle {
  const instance = render(createElement(InteractiveApp, options), {
    exitOnCtrlC: false,
    ...renderOptions,
  })
  return {
    clear: () => instance.clear(),
    unmount: () => instance.unmount(),
    waitUntilRenderFlush: async () => {
      await instance.waitUntilRenderFlush()
    },
    waitUntilExit: async () => {
      await instance.waitUntilExit()
    },
  }
}

export function renderDirectoryTrustPrompt(input: {
  canonicalPath: string
  parentPath: string
}): Promise<DirectoryTrustDecision> {
  return new Promise((resolve) => {
    let settled = false
    const instance = render(
      createElement(DirectoryTrustPrompt, {
        ...input,
        onDecision(decision: DirectoryTrustDecision) {
          if (settled) return
          settled = true
          instance.unmount()
          resolve(decision)
        },
      }),
      { exitOnCtrlC: false },
    )
  })
}
