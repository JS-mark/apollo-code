import { randomUUID } from 'node:crypto'
import {
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { PermissionManager, PermissionSpec } from '@apollo-code/permission'
import type { ContentPart } from '@apollo-code/provider-kit'
import type { DispatchParent, SubagentBudget, SubagentDispatcher } from '@apollo-code/subagent'
import type { Tool, ToolContext, ToolResult } from '@apollo-code/tool-kit'

import { WebSearchTool, type WebSearchProvider } from './web-search'
export * from './web-search'

const objectSchema = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, properties, required }) as never
const stringProp = { type: 'string', minLength: 1 }
const result = (text: string, meta: NonNullable<ToolResult['meta']>): ToolResult => ({
  content: [{ type: 'text', text }],
  meta,
})
const failure = (error: unknown, started = Date.now()): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  meta: { durationMs: Date.now() - started },
})
function pathInCwd(cwd: string, input: string): string {
  const path = resolve(cwd, input)
  const rel = relative(resolve(cwd), path)
  if (rel.startsWith('..')) throw new Error('Path escapes working directory')
  return path
}

export interface FileMutationTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface FileBackupPort {
  prepare(sessionId: string, paths: string[]): Promise<FileMutationTransaction>
}

export interface BuiltinToolsOptions {
  backups?: FileBackupPort
  task?: { dispatcher: SubagentDispatcher; parent: (signal: AbortSignal) => DispatchParent }
  webSearch?: { provider?: WebSearchProvider }
}

async function safeMutationPath(cwd: string, input: string): Promise<string> {
  const path = pathInCwd(cwd, input)
  const root = await realpath(cwd)
  const parent = await realpath(resolve(path, '..'))
  const rel = relative(root, parent)
  if (rel.startsWith('..')) throw new Error('Path escapes working directory through a symlink')
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing to mutate a symbolic link')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temporary = resolve(path, `.${randomUUID()}.apollo-tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function mutateFiles(
  sessionId: string,
  updates: Array<{ path: string; content: string }>,
  backups?: FileBackupPort,
): Promise<void> {
  const releases: Array<() => Promise<void>> = []
  const paths = [...new Set(updates.map((update) => update.path))].toSorted()
  let transaction: FileMutationTransaction | undefined
  try {
    for (const path of paths) releases.push(await acquireMutationLock(path, sessionId))
    transaction = backups
      ? await backups.prepare(sessionId, paths)
      : await prepareEphemeralTransaction(paths)
    for (const update of updates) await atomicWrite(update.path, update.content)
    await transaction?.commit()
  } catch (error) {
    await transaction?.rollback().catch(() => undefined)
    throw error
  } finally {
    for (const release of releases.toReversed()) await release()
  }
}

async function prepareEphemeralTransaction(paths: string[]): Promise<FileMutationTransaction> {
  const snapshots = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, content: await readFile(path), existed: true as const }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { path, existed: false as const }
        throw error
      }
    }),
  )
  let settled = false
  return {
    async commit() {
      settled = true
    },
    async rollback() {
      if (settled) return
      for (const snapshot of snapshots.toReversed()) {
        if (snapshot.existed) await writeFile(snapshot.path, snapshot.content)
        else await rm(snapshot.path, { force: true })
      }
      settled = true
    },
  }
}

async function acquireMutationLock(path: string, sessionId: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.apollolock`
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${sessionId}\n`)
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 3)
        throw new Error('File locked by another apollo session; retry later', { cause: error })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
    }
  }
  throw new Error('File locked by another apollo session; retry later', { cause: lastError })
}

export class ReadTool implements Tool<{ path: string; offset?: number; limit?: number }> {
  readonly name = 'Read'
  readonly description = 'Read a UTF-8 file'
  readonly readonly = true
  readonly parallelSafe = true
  readonly inputSchema = objectSchema(
    {
      path: stringProp,
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1 },
    },
    ['path'],
  )
  permissionSpec(input: { path: string }): PermissionSpec {
    return { fs: { read: [input.path] } }
  }
  async invoke(
    input: { path: string; offset?: number; limit?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const started = Date.now()
    try {
      const text = await readFile(pathInCwd(ctx.session.cwd, input.path), 'utf8')
      const lines = text
        .split('\n')
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 2000))
      return result(lines.join('\n'), {
        durationMs: Date.now() - started,
        bytesRead: Buffer.byteLength(text),
      })
    } catch (e) {
      return failure(e, started)
    }
  }
}
export class WriteTool implements Tool<{ path: string; content: string }> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'Write'
  readonly description = 'Create or overwrite a file'
  readonly inputSchema = objectSchema({ path: stringProp, content: { type: 'string' } }, [
    'path',
    'content',
  ])
  readonly sandboxRequired = true
  permissionSpec(i: { path: string }): PermissionSpec {
    return { fs: { write: [i.path] } }
  }
  async invoke(i: { path: string; content: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const p = await safeMutationPath(c.session.cwd, i.path)
      await mutateFiles(c.session.id, [{ path: p, content: i.content }], this.backups)
      return result('File written', {
        durationMs: Date.now() - s,
        bytesWritten: Buffer.byteLength(i.content),
        filesTouched: [p],
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export class EditTool implements Tool<{ path: string; oldText: string; newText: string }> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'Edit'
  readonly description = 'Replace one exact string in a file'
  readonly inputSchema = objectSchema(
    { path: stringProp, oldText: stringProp, newText: { type: 'string' } },
    ['path', 'oldText', 'newText'],
  )
  readonly sandboxRequired = true
  permissionSpec(i: { path: string }): PermissionSpec {
    return { fs: { read: [i.path], write: [i.path] } }
  }
  async invoke(i: { path: string; oldText: string; newText: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const p = await safeMutationPath(c.session.cwd, i.path),
        old = await readFile(p, 'utf8'),
        count = old.split(i.oldText).length - 1
      if (count !== 1) throw new Error(`Expected exactly one match, found ${count}`)
      const next = old.replace(i.oldText, i.newText)
      await mutateFiles(c.session.id, [{ path: p, content: next }], this.backups)
      return result('File edited', {
        durationMs: Date.now() - s,
        bytesWritten: Buffer.byteLength(next),
        filesTouched: [p],
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}

export interface MultiEditInput {
  edits: Array<{ path: string; oldText: string; newText: string }>
}

export class MultiEditTool implements Tool<MultiEditInput> {
  constructor(readonly backups?: FileBackupPort) {}
  readonly name = 'MultiEdit'
  readonly description = 'Atomically apply exact replacements across multiple files'
  readonly inputSchema = objectSchema(
    {
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'oldText', 'newText'],
          properties: { path: stringProp, oldText: stringProp, newText: { type: 'string' } },
        },
      },
    },
    ['edits'],
  )
  readonly sandboxRequired = true
  readonly parallelSafe = false
  permissionSpec(input: MultiEditInput): PermissionSpec {
    const paths = [...new Set(input.edits.map((edit) => edit.path))]
    return { fs: { read: paths, write: paths } }
  }
  async invoke(input: MultiEditInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now()
    try {
      const grouped = new Map<string, Array<{ oldText: string; newText: string }>>()
      for (const edit of input.edits) {
        const path = await safeMutationPath(context.session.cwd, edit.path)
        grouped.set(path, [...(grouped.get(path) ?? []), edit])
      }
      const updates: Array<{ path: string; content: string }> = []
      for (const [path, edits] of grouped) {
        let content = await readFile(path, 'utf8')
        for (const edit of edits) {
          const count = content.split(edit.oldText).length - 1
          if (count !== 1)
            throw new Error(
              `Expected exactly one match in ${relative(context.session.cwd, path)}, found ${count}`,
            )
          content = content.replace(edit.oldText, edit.newText)
        }
        updates.push({ path, content })
      }
      await mutateFiles(context.session.id, updates, this.backups)
      return result(`Edited ${updates.length} file(s)`, {
        durationMs: Date.now() - started,
        bytesWritten: updates.reduce((sum, update) => sum + Buffer.byteLength(update.content), 0),
        filesTouched: updates.map((update) => update.path),
      })
    } catch (error) {
      return failure(error, started)
    }
  }
}
export class BashTool implements Tool<{ command: string }> {
  readonly name = 'Bash'
  readonly description = 'Run a command in the Rust sandbox'
  readonly inputSchema = objectSchema({ command: stringProp }, ['command'])
  readonly sandboxRequired = true
  readonly parallelSafe = false
  permissionSpec(i: { command: string }): PermissionSpec {
    return { bash: { command: i.command }, fs: { read: ['.'], write: ['.'] } }
  }
  async invoke(i: { command: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const out = await c.native.execute(i.command, [], c.abortSignal)
      return result(typeof out === 'string' ? out : JSON.stringify(out), {
        durationMs: Date.now() - s,
      })
    } catch (e) {
      return failure(e, s)
    }
  }
}
async function walk(root: string, base = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = resolve(root, entry.name)
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    if (entry.isDirectory()) await walk(p, base, out)
    else out.push(relative(base, p))
  }
  return out
}
export class GlobTool implements Tool<{ pattern: string; path?: string }> {
  readonly name = 'Glob'
  readonly description = 'Find files using a glob'
  readonly readonly = true
  readonly inputSchema = objectSchema({ pattern: stringProp, path: { type: 'string' } }, [
    'pattern',
  ])
  permissionSpec(i: { path?: string }): PermissionSpec {
    return { fs: { read: [i.path ?? '.'] } }
  }
  async invoke(i: { pattern: string; path?: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const root = pathInCwd(c.session.cwd, i.path ?? '.'),
        escaped = i.pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '.'),
        re = new RegExp(`^${escaped}$`),
        files = (await walk(root)).filter((x) => re.test(x))
      return result(files.join('\n'), { durationMs: Date.now() - s })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export class GrepTool implements Tool<{ pattern: string; path?: string }> {
  readonly name = 'Grep'
  readonly description = 'Search text in files'
  readonly readonly = true
  readonly inputSchema = objectSchema({ pattern: stringProp, path: { type: 'string' } }, [
    'pattern',
  ])
  permissionSpec(i: { path?: string }): PermissionSpec {
    return { fs: { read: [i.path ?? '.'] } }
  }
  async invoke(i: { pattern: string; path?: string }, c: ToolContext) {
    const s = Date.now()
    try {
      const root = pathInCwd(c.session.cwd, i.path ?? '.'),
        re = new RegExp(i.pattern),
        matches: string[] = []
      for (const file of await walk(root)) {
        let text: string
        try {
          text = await readFile(resolve(root, file), 'utf8')
        } catch {
          continue
        }
        text.split('\n').forEach((line, n) => {
          if (re.test(line)) matches.push(`${file}:${n + 1}:${line}`)
        })
      }
      return result(matches.join('\n'), { durationMs: Date.now() - s })
    } catch (e) {
      return failure(e, s)
    }
  }
}
export class TodoTool implements Tool<{
  items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }>
}> {
  readonly name = 'Todo'
  readonly description = 'Replace the session todo list'
  readonly readonly = true
  readonly inputSchema = objectSchema(
    {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'status'],
          properties: { text: stringProp, status: { enum: ['pending', 'in_progress', 'done'] } },
        },
      },
    },
    ['items'],
  )
  permissionSpec(): PermissionSpec {
    return {}
  }
  async invoke(i: { items: Array<{ text: string; status: string }> }) {
    return result(JSON.stringify(i.items), { durationMs: 0 })
  }
}

export class TaskTool implements Tool<{
  prompt: string
  agentType?: string
  budget?: SubagentBudget
}> {
  readonly name = 'Task'
  readonly description = 'Run an isolated, depth-limited subagent and return its untrusted result'
  readonly parallelSafe = true
  readonly timeoutMs = 10 * 60_000
  readonly inputSchema = objectSchema(
    {
      prompt: stringProp,
      agentType: { type: 'string' },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tokenMax: { type: 'integer', minimum: 1 },
          costUSDMax: { type: 'number', minimum: 0 },
          timeMsMax: { type: 'integer', minimum: 1 },
          toolCallMax: { type: 'integer', minimum: 1 },
        },
      },
    },
    ['prompt'],
  )
  constructor(
    readonly dispatcher: SubagentDispatcher,
    readonly parent: (signal: AbortSignal) => DispatchParent,
  ) {}
  permissionSpec(): PermissionSpec {
    return {}
  }
  async invoke(
    input: { prompt: string; agentType?: string; budget?: SubagentBudget },
    context: ToolContext,
  ) {
    const started = Date.now()
    try {
      const dispatched = await this.dispatcher.dispatch(this.parent(context.abortSignal), input)
      return {
        content: [{ type: 'text' as const, text: dispatched.text }],
        isError: dispatched.status === 'failed' || dispatched.status === 'cancelled',
        meta: { durationMs: Date.now() - started, costImpact: 'high' as const },
      }
    } catch (error) {
      return failure(error, started)
    }
  }
}

export const builtinTools = (options: BuiltinToolsOptions = {}): Tool[] => [
  new ReadTool(),
  new WriteTool(options.backups),
  new EditTool(options.backups),
  new MultiEditTool(options.backups),
  new BashTool(),
  new GrepTool(),
  new GlobTool(),
  new TodoTool(),
  new WebSearchTool(options.webSearch?.provider),
  ...(options.task ? [new TaskTool(options.task.dispatcher, options.task.parent)] : []),
]
function validate(schema: Record<string, unknown>, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object'
  for (const key of (schema.required as string[]) ?? [])
    if (!(key in input)) return `missing required property: ${key}`
  if (schema.additionalProperties === false)
    for (const key of Object.keys(input))
      if (!Object.hasOwn(schema.properties as object, key)) return `unknown property: ${key}`
}
export class ToolExecutor {
  constructor(
    readonly permissions: PermissionManager,
    readonly context: (signal: AbortSignal) => ToolContext,
  ) {}
  async execute(tool: Tool, input: unknown, signal: AbortSignal): Promise<ToolResult> {
    const error = validate(tool.inputSchema, input)
    if (error) return failure(new Error(`Invalid input: ${error}`))
    try {
      return await this.permissions.requestAndExecute(
        {
          toolName: tool.name,
          spec: tool.permissionSpec(input),
          input,
          session: { id: this.context(signal).session.id, cwd: this.context(signal).session.cwd },
          attempt: 1,
        },
        () => tool.invoke(input, this.context(signal)),
      )
    } catch (e) {
      return failure(e)
    }
  }
}

export function truncateToolResult(parts: ContentPart[], maxCharacters = 87_500): ContentPart[] {
  return parts.map((part) => {
    if (part.type !== 'text' || part.text.length <= maxCharacters) return part
    const half = Math.floor(maxCharacters / 2),
      removed = part.text.length - maxCharacters
    return {
      ...part,
      text: `${part.text.slice(0, half)}\n[... truncated approximately ${Math.ceil(removed / 3.5)} tokens ...]\n${part.text.slice(-half)}`,
    }
  })
}
