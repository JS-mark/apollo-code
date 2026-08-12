export type MemoryPanelErrorCode =
  | 'memory_conflict'
  | 'memory_corrupt'
  | 'memory_index_corrupt'
  | 'memory_index_busy'
  | 'memory_index_unavailable'
  | 'memory_io'
  | 'memory_not_found'
  | 'memory_scope_denied'
  | 'memory_validation'
  | 'memory_unknown'

export interface MemoryPanelError extends Error {
  code?: MemoryPanelErrorCode
}

export interface MemoryPanelRecord {
  id: string
  content: string
  tags: readonly string[]
  pinned: boolean
  scope: string
  source: string
  actor?: string
  createdAt: string
  updatedAt: string
}

export interface MemoryPanelPage {
  items: readonly MemoryPanelRecord[]
  nextCursor?: string
}

export interface MemoryPanelController {
  readonly scopeLabel: string
  readonly searchAvailable: boolean
  list(input: { cursor?: string; limit: number; signal?: AbortSignal }): Promise<MemoryPanelPage>
  search(input: {
    query: string
    limit: number
    signal?: AbortSignal
  }): Promise<readonly MemoryPanelRecord[]>
  get(id: string, signal?: AbortSignal): Promise<MemoryPanelRecord | undefined>
  update(
    id: string,
    patch: { content: string; tags: readonly string[] },
    expectedUpdatedAt: string,
  ): Promise<MemoryPanelRecord>
  delete(id: string, expectedUpdatedAt: string): Promise<void>
  pin(id: string, expectedUpdatedAt: string): Promise<MemoryPanelRecord>
  unpin(id: string, expectedUpdatedAt: string): Promise<MemoryPanelRecord>
}

export type MemoryPanelMode =
  | 'confirmDelete'
  | 'conflict'
  | 'detail'
  | 'discardEdit'
  | 'edit'
  | 'empty'
  | 'list'
  | 'loadError'
  | 'loading'
  | 'mutating'
  | 'noMatch'
  | 'searchError'
  | 'searching'

export function memoryPanelError(error: unknown): { code: MemoryPanelErrorCode; message: string } {
  const value = error as MemoryPanelError
  return {
    code: value?.code ?? 'memory_unknown',
    message: error instanceof Error ? error.message : String(error),
  }
}

export function truncateTerminal(value: string, columns: number): string {
  if (columns <= 0) return ''
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  const output: Array<{ character: string; width: number }> = []
  let width = 0
  for (const character of normalized) {
    const next = terminalCharacterWidth(character)
    if (width + next > columns) {
      while (output.length && width + 1 > columns) width -= output.pop()!.width
      return `${output.map((item) => item.character).join('')}…`
    }
    output.push({ character, width: next })
    width += next
  }
  return output.map((item) => item.character).join('')
}

export function wrapTerminalLines(value: string, columns: number): string[] {
  const lines: string[] = []
  const widthLimit = Math.max(1, columns)
  for (const sourceLine of value.split('\n')) {
    let line = ''
    let width = 0
    for (const character of sourceLine) {
      const characterWidth = terminalCharacterWidth(character)
      if (line && width + characterWidth > widthLimit) {
        lines.push(line)
        line = ''
        width = 0
      }
      line += character
      width += characterWidth
    }
    lines.push(line)
  }
  return lines.length ? lines : ['']
}

function terminalCharacterWidth(character: string): number {
  const point = character.codePointAt(0) ?? 0
  if (point === 0 || point < 32 || (point >= 0x7f && point < 0xa0)) return 0
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff))
    ? 2
    : 1
}
