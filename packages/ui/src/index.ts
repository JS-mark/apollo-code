export type SandboxTier = 'full' | 'none' | 'partial' | 'weak'
export interface SandboxDisclosure { tier: SandboxTier; mechanism: string; features: { filesystem: boolean; network: boolean }; degradationReasons: readonly string[] }
export type DangerousMode = 'no-sandbox' | 'skip-permissions'

export function renderSecurityBanner(modes: readonly DangerousMode[], color: boolean): string {
  const labels = modes.map(mode => mode === 'no-sandbox' ? 'DANGER: NO SANDBOX' : 'DANGER: PERMISSIONS DISABLED')
  if (labels.length === 0) return ''
  const text = ` ${labels.join(' | ')} `
  return color ? `\u001B[41m\u001B[97m${text}\u001B[0m` : text
}

export function renderSandboxDisclosure(probe: SandboxDisclosure): string {
  const limitations = probe.degradationReasons.length === 0 ? 'none' : probe.degradationReasons.join('; ')
  return [`Sandbox: ${probe.tier.toUpperCase()}`, `Mechanism: ${probe.mechanism}`, `Filesystem isolation: ${probe.features.filesystem ? 'enforced' : 'unavailable'}`, `Network egress: ${probe.features.network ? 'enforced' : 'unavailable'}`, `Limitations: ${limitations}`].join('\n')
}

export function renderPrivacyDisclosure(): string {
  return ['Before we start:', 'Apollo saves session logs locally.', 'Apollo does not send analytics anywhere by default.', 'Prompts and code are sent only through the provider you choose.'].join('\n')
}

export interface SessionView { id: string; interruptedText: string | null; pendingText: string; status: 'active' | 'ended' | 'interrupted'; transcript: string[] }
export type SessionViewEvent = { type: 'message.interrupted' | 'session.ended' } | { type: 'stream.completed' | 'stream.delta'; text?: string }
export function createSessionView(id: string): SessionView { return { id, interruptedText: null, pendingText: '', status: 'active', transcript: [] } }
export function applySessionEvent(view: SessionView, event: SessionViewEvent): void {
  if (event.type === 'stream.delta') view.pendingText += event.text ?? ''
  if (event.type === 'stream.completed') { view.transcript.push(event.text ?? view.pendingText); view.pendingText = '' }
  if (event.type === 'message.interrupted') { view.interruptedText = view.pendingText; view.pendingText = ''; view.status = 'interrupted' }
  if (event.type === 'session.ended') view.status = 'ended'
}
