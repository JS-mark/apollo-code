import { render, type RenderOptions } from 'ink'
import { createElement } from 'react'

import { InteractiveApp, type InteractiveAppOptions } from './app'

export interface InteractiveAppHandle {
  clear(): void
  unmount(): void
  waitUntilRenderFlush(): Promise<void>
  waitUntilExit(): Promise<void>
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
