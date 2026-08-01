export type SandboxTier = 'full' | 'none' | 'partial' | 'weak'
export interface SandboxDisclosure {
  tier: SandboxTier
  mechanism: string
  features: { filesystem: boolean; network: boolean }
  degradationReasons: readonly string[]
}
export type DangerousMode = 'no-sandbox' | 'skip-permissions'

export function renderSecurityBanner(modes: readonly DangerousMode[], color: boolean): string {
  const labels = modes.map((mode) =>
    mode === 'no-sandbox' ? 'DANGER: NO SANDBOX' : 'DANGER: PERMISSIONS DISABLED',
  )
  if (labels.length === 0) return ''
  const text = ` ${labels.join(' | ')} `
  return color ? `\u001B[41m\u001B[97m${text}\u001B[0m` : text
}

export function renderSandboxDisclosure(probe: SandboxDisclosure): string {
  const limitations =
    probe.degradationReasons.length === 0 ? 'none' : probe.degradationReasons.join('; ')
  return [
    `Sandbox: ${probe.tier.toUpperCase()}`,
    `Mechanism: ${probe.mechanism}`,
    `Filesystem isolation: ${probe.features.filesystem ? 'enforced' : 'unavailable'}`,
    `Network egress: ${probe.features.network ? 'enforced' : 'unavailable'}`,
    `Limitations: ${limitations}`,
  ].join('\n')
}

export function renderPrivacyDisclosure(): string {
  return [
    'Before we start:',
    'Apollo saves session logs locally.',
    'Apollo does not send analytics anywhere by default.',
    'Prompts and code are sent only through the provider you choose.',
  ].join('\n')
}

export interface SessionView {
  id: string
  interruptedText: string | null
  pendingText: string
  status: 'active' | 'ended' | 'interrupted'
  transcript: string[]
}
export type SessionViewEvent =
  | { type: 'message.interrupted' | 'session.ended' }
  | { type: 'stream.completed' | 'stream.delta'; text?: string }
export function createSessionView(id: string): SessionView {
  return { id, interruptedText: null, pendingText: '', status: 'active', transcript: [] }
}
export function applySessionEvent(view: SessionView, event: SessionViewEvent): void {
  if (event.type === 'stream.delta') view.pendingText += event.text ?? ''
  if (event.type === 'stream.completed') {
    view.transcript.push(event.text ?? view.pendingText)
    view.pendingText = ''
  }
  if (event.type === 'message.interrupted') {
    view.interruptedText = view.pendingText
    view.pendingText = ''
    view.status = 'interrupted'
  }
  if (event.type === 'session.ended') view.status = 'ended'
}

export interface ModelAlias {
  alias: string
  model: string
}
export interface PickerCandidate {
  kind: 'file' | 'model'
  label: string
  value: string
}
export type PickerMode = 'file' | 'model' | 'unified'

export function pickerMode(input: string): PickerMode {
  if (input.startsWith('@@')) return 'file'
  if (input.startsWith('@!')) return 'model'
  return 'unified'
}

export function createPickerCandidates(
  input: string,
  aliases: readonly ModelAlias[],
  files: readonly string[],
): PickerCandidate[] {
  const mode = pickerMode(input)
  const prefix = input.slice(mode === 'unified' ? 1 : 2).toLocaleLowerCase()
  const models =
    mode === 'file'
      ? []
      : aliases
          .filter((item) => item.alias.toLocaleLowerCase().startsWith(prefix))
          .map((item) => ({ kind: 'model' as const, label: `⭐ ${item.alias}`, value: item.model }))
  const paths =
    mode === 'model'
      ? []
      : files
          .filter((path) => path.toLocaleLowerCase().startsWith(prefix))
          .map((path) => ({ kind: 'file' as const, label: `📄 ${path}`, value: path }))
  return [...models, ...paths]
}

export interface PickerSelection {
  attachment?: string
  hint?: { explicitModel: string }
  text: string
}
export function applyPickerSelection(input: string, candidate: PickerCandidate): PickerSelection {
  const suffix = input.replace(/^@{1,2}!?[^\s]*/, '').trimStart()
  if (candidate.kind === 'model') return { hint: { explicitModel: candidate.value }, text: suffix }
  return {
    attachment: candidate.value,
    text: `[@file:${candidate.value}]${suffix ? ` ${suffix}` : ''}`,
  }
}

export interface PermissionPrompt {
  description: string
  diff?: string
  id: string
  risk: 'high' | 'low' | 'medium'
}
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'
export class PermissionPromptQueue {
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly show: (prompt: PermissionPrompt) => Promise<PermissionDecision>) {}
  request(prompt: PermissionPrompt): Promise<PermissionDecision> {
    const result = this.#tail.then(() => this.show(prompt))
    this.#tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}

export function renderPermissionPrompt(prompt: PermissionPrompt): string {
  return [
    `Permission required [${prompt.risk.toUpperCase()}]`,
    prompt.description,
    prompt.diff ? renderDiff(prompt.diff) : '',
    '[allow once] [allow session] [deny]',
  ]
    .filter(Boolean)
    .join('\n')
}
export function renderDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) =>
      line.startsWith('+') && !line.startsWith('+++')
        ? `+ ${line.slice(1)}`
        : line.startsWith('-') && !line.startsWith('---')
          ? `- ${line.slice(1)}`
          : `  ${line}`,
    )
    .join('\n')
}

export function resumeSessionView(view: SessionView, transcript: readonly string[]): void {
  view.transcript = [...transcript]
  view.pendingText = ''
  view.interruptedText = null
  view.status = 'active'
}
