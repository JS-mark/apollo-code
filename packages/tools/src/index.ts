import { readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { PermissionManager, PermissionSpec } from '@apollo-code/permission'
import type { ContentPart } from '@apollo-code/provider-kit'
import type { Tool, ToolContext, ToolResult } from '@apollo-code/tool-kit'

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
      const p = pathInCwd(c.session.cwd, i.path)
      await writeFile(p, i.content, { encoding: 'utf8', flag: 'w' })
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
      const p = pathInCwd(c.session.cwd, i.path),
        old = await readFile(p, 'utf8'),
        count = old.split(i.oldText).length - 1
      if (count !== 1) throw new Error(`Expected exactly one match, found ${count}`)
      const next = old.replace(i.oldText, i.newText)
      await writeFile(p, next, 'utf8')
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

export const builtinTools = (): Tool[] => [
  new ReadTool(),
  new WriteTool(),
  new EditTool(),
  new BashTool(),
  new GrepTool(),
  new GlobTool(),
  new TodoTool(),
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
