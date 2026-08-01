import { workerPool } from './worker-pool'
export interface SearchOptions {
  pattern: string
  cwd: string
}
export interface SearchMatch {
  path: string
  line: number
  text: string
}
export async function* search(
  options: SearchOptions,
  _signal?: AbortSignal,
): AsyncIterable<SearchMatch> {
  try {
    const result = (await workerPool.call('search', 'search.query', options)) as {
      matches?: SearchMatch[]
    }
    yield* result.matches ?? []
  } catch {
    /* An unavailable native worker degrades to an empty, safe result. */
  }
}
