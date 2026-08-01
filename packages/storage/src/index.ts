import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { open, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import type { CoreEvent, EventBus, PromptComposer } from '@apollo-code/core'
import type { PermissionManager } from '@apollo-code/permission'
import { sanitize, type JsonValue } from '@apollo-code/shared'
export interface StoredEvent {
  v: 1
  id: string
  type: string
  sessionId: string
  at: string
  payload: JsonValue
}
export class SessionStore {
  readonly #seen = new Set<string>()
  constructor(readonly path: string) {}
  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => this.appendCore(event))
  }
  async appendCore(event: CoreEvent): Promise<void> {
    if (event.type === 'stream.delta' || this.#seen.has(event.id)) return
    this.#seen.add(event.id)
    await this.append({
      v: 1,
      id: event.id,
      type: event.type,
      sessionId: event.sessionId,
      at: new Date().toISOString(),
      payload: event.payload,
    })
  }
  async append(event: StoredEvent): Promise<void> {
    if (containsInlineBinary(event.payload))
      throw new Error('Binary attachments cannot be written to session JSONL')
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600)
    try {
      await file.write(`${JSON.stringify(event)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  async load(): Promise<StoredEvent[]> {
    const out: StoredEvent[] = []
    try {
      const rl = createInterface({ input: createReadStream(this.path), crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line) continue
        const event = JSON.parse(line) as StoredEvent
        if (event.v > 1) throw new Error('Session is from a newer Apollo version')
        out.push(event)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return out
  }
  async resume(tailTurns = 20): Promise<StoredEvent[]> {
    const all = await this.load(),
      starts = all.map((e, i) => (e.type === 'turn.started' ? i : -1)).filter((i) => i >= 0),
      from = starts.at(-tailTurns) ?? 0
    return all.slice(from)
  }
}
function containsInlineBinary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (value instanceof Uint8Array) return true
  return Object.values(value).some(containsInlineBinary)
}
export interface PromptLoaderOptions {
  cwd: string
  apolloHome?: string
  permissions: PermissionManager
  maxDepth?: number
  maxIncludes?: number
}
export class PromptLoader {
  #count = 0
  constructor(readonly options: PromptLoaderOptions) {}
  async load(path: string): Promise<string> {
    this.#count = 0
    return this.expand(path, 0, new Set())
  }
  async registerProject(composer: PromptComposer): Promise<Array<{ dispose(): void }>> {
    const out = []
    let current = await realpath(this.options.cwd),
      home = await realpath(homedir())
    for (let level = 0; level < 8; level++) {
      const agent = resolve(current, 'AGENT.md'),
        claude = resolve(current, 'CLAUDE.md')
      let path: string | undefined
      try {
        await open(agent, 'r').then((f) => f.close())
        path = agent
      } catch {
        try {
          await open(claude, 'r').then((f) => f.close())
          path = claude
        } catch {}
      }
      if (path) {
        out.push(
          composer.register({
            id: `project:${path}`,
            source: `project:${path}`,
            priority: Math.max(500, 600 - level * 10),
            text: await this.load(path),
          }),
        )
      }
      if (current === home || dirname(current) === current) break
      current = dirname(current)
    }
    const user = resolve(this.options.apolloHome ?? resolve(homedir(), '.apollo'), 'PROMPT.md')
    try {
      out.push(
        composer.register({
          id: 'user',
          source: 'user',
          priority: 400,
          text: await this.load(user),
        }),
      )
    } catch {}
    return out
  }
  private async expand(path: string, depth: number, seen: Set<string>): Promise<string> {
    if (depth > (this.options.maxDepth ?? 8)) return `<!-- include: ${path} — DENIED (depth) -->`
    if (this.#count++ >= (this.options.maxIncludes ?? 64))
      return `<!-- include: ${path} — DENIED (limit) -->`
    if (extname(path).toLowerCase() !== '.md') return `<!-- include: ${path} — DENIED (non-md) -->`
    if (sensitive(path)) return `<!-- include: ${path} — DENIED (sensitive) -->`
    const target = isAbsolute(path) ? path : resolve(this.options.cwd, path)
    let canonical: string
    try {
      canonical = await realpath(target)
    } catch {
      return `<!-- include: ${path} — ERROR (not found) -->`
    }
    const roots = [
      await realpath(this.options.cwd),
      await mkdir(this.options.apolloHome ?? resolve(homedir(), '.apollo'), {
        recursive: true,
      }).then(() => realpath(this.options.apolloHome ?? resolve(homedir(), '.apollo'))),
    ]
    if (
      !roots.some((root) => {
        const rel = relative(root, canonical)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      })
    )
      return `<!-- include: ${path} — DENIED (outside roots) -->`
    if (seen.has(canonical)) return `<!-- include: ${path} — DENIED (cycle) -->`
    const decision = await this.options.permissions.request({
      toolName: 'Read',
      spec: { fs: { read: [canonical] } },
      input: { path: canonical },
      session: { id: 'prompt-loader', cwd: roots[0]! },
      attempt: 1,
    })
    if (decision.kind.startsWith('deny')) return `<!-- include: ${path} — DENIED (permission) -->`
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    let text: string
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('not a file')
      text = await file.readFile('utf8')
    } finally {
      await file.close()
    }
    const next = new Set(seen).add(canonical)
    let fenced = false
    const lines = text.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('```')) fenced = !fenced
      if (fenced) continue
      const match = /^@include ([^#\s]+)(?:\s+#.*)?$/.exec(lines[i]!)
      if (match) {
        const child = match[1]!.startsWith('~/')
          ? resolve(homedir(), match[1]!.slice(2))
          : resolve(dirname(canonical), match[1]!)
        const body = await this.expand(child, depth + 1, next)
        lines[i] =
          `<!-- include: ${match[1]} depth=${depth + 1} -->\n${body}\n<!-- /include ${match[1]} -->`
      }
    }
    return lines.join('\n')
  }
}
function sensitive(path: string): boolean {
  return (
    /(?:^|\/)(?:\.env[^/]*|credentials[^/]*|auth[^/]*|id_[^/]+|[^/]*\.(?:pem|key))$/i.test(path) ||
    path.includes('/.ssh/')
  )
}
export async function sourceHash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
export function sanitizeSession<T>(value: T): T {
  return sanitize(value)
}
