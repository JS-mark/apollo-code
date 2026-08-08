import { useInput } from 'ink'

import type { WelcomePanelData } from '../welcome'
import { WelcomePanel } from './WelcomePanel'

export interface StatusPanelProps {
  data: WelcomePanelData
  onClose?: () => void
}

export function StatusPanel({ data, onClose }: StatusPanelProps) {
  useInput((_, key) => {
    if (key.escape) onClose?.()
  })

  return <WelcomePanel compact data={data} footer="Esc close" title="Status" />
}
