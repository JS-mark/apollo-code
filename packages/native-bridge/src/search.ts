import { readFile } from 'node:fs/promises'

import { VolundError } from '@volund/shared'
import fg from 'fast-glob'

import { nativeProbes } from './probe'
import { workerPool } from './worker-pool'

export interface SearchOptions {
  pattern: string
  path?: string
  cwd?: string
  glob?: string
  caseInsensitive?: boolean
  maxMatches?: number
  ignore?: string[]
}
export interface SearchMatch {
  path: string
  lineNumber: number
  line: string
  span?: { start: number; end: number }
}
export interface AstQueryOptions {
  query: string
  language: 'javascript' | 'typescript' | 'tsx' | 'python' | 'rust'
  path?: string
  cwd?: string
  maxMatches?: number
  /** Extra ignore patterns applied on top of gitignore/.volundignore. */
  ignore?: string[]
}
export interface AstMatch {
  path: string
  capture: string
  text: string
  span: { start: number; end: number }
  start: { line: number; column: number }
  end: { line: number; column: number }
}
export interface GlobFilesOptions {
  pattern: string
  path?: string
  cwd?: string
  maxMatches?: number
  ignore?: string[]
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

async function fallbackSearch(
  options: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  const cwd = options.path ?? options.cwd ?? '.'
  const expression = new RegExp(options.pattern, options.caseInsensitive ? 'giu' : 'gu')
  const files = await fg(options.glob ?? '**/*', {
    cwd,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**', '**/target/**', ...(options.ignore ?? [])],
  })
  const matches: SearchMatch[] = []
  const limit = Math.min(options.maxMatches ?? 10_000, 10_000)
  for (const path of files) {
    throwIfAborted(signal)
    const bytes = await readFile(path)
    if (bytes.subarray(0, 8192).includes(0)) continue
    const text = bytes.toString('utf8')
    let offset = 0
    // Byte offsets must count the raw line including a trailing \r, while
    // matching runs on the stripped line (CRLF files would drift).
    for (const [index, rawLine] of text.split('\n').entries()) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      expression.lastIndex = 0
      for (const found of line.matchAll(expression)) {
        matches.push({
          path,
          lineNumber: index + 1,
          line,
          span: { start: offset + found.index, end: offset + found.index + found[0].length },
        })
        if (matches.length >= limit) return matches
      }
      offset += Buffer.byteLength(rawLine) + 1
    }
  }
  return matches
}

/**
 * r13-P1: read-only search never waits for probing — the JS fallback answers
 * while `available.search` is `'probing'`/`false`, native picks up after backfill.
 */
function nativeSearchReady(): boolean {
  return nativeProbes.available.search === true
}

export async function* search(
  options: SearchOptions,
  signal?: AbortSignal,
): AsyncIterable<SearchMatch> {
  throwIfAborted(signal)
  if (nativeSearchReady()) {
    try {
      const result = (await workerPool.call('search', 'search.query', options)) as {
        matches?: SearchMatch[]
      }
      for (const match of result.matches ?? []) {
        throwIfAborted(signal)
        yield match
      }
      return
    } catch {
      // fall through to the JS implementation
    }
  }
  throwIfAborted(signal)
  for (const match of await fallbackSearch(options, signal)) yield match
}

export async function* astQuery(
  options: AstQueryOptions,
  signal?: AbortSignal,
): AsyncIterable<AstMatch> {
  throwIfAborted(signal)
  if (!nativeSearchReady())
    throw new VolundError(
      'native_bridge_ast_query_native_required',
      'AST query requires the native volund-search worker',
    )
  let result: { matches?: AstMatch[] }
  try {
    result = (await workerPool.call('search', 'search.ast_query', options)) as typeof result
  } catch (error) {
    throw new VolundError(
      'native_bridge_ast_query_native_required',
      'AST query requires the native volund-search worker',
      undefined,
      { cause: error },
    )
  }
  for (const match of result.matches ?? []) {
    throwIfAborted(signal)
    yield match
  }
}

/** Gitignore/.volundignore-aware file listing for a single include glob. */
export async function globFiles(
  options: GlobFilesOptions,
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal)
  const root = options.path ?? options.cwd ?? '.'
  if (nativeSearchReady()) {
    try {
      const result = (await workerPool.call('search', 'search.glob_files', options)) as {
        matches?: string[]
      }
      return result.matches ?? []
    } catch {
      // fall through to the JS implementation
    }
  }
  const files = await fg(options.pattern, {
    cwd: root,
    absolute: false,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ['**/.git/**', '**/node_modules/**', '**/target/**', ...(options.ignore ?? [])],
    suppressErrors: true,
  })
  return files.slice(0, Math.min(options.maxMatches ?? 10_000, 10_000))
}
