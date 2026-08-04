import { promises as fs } from 'node:fs'

import { createTwoFilesPatch } from 'diff'
import { encode } from 'gpt-tokenizer'
import iconv from 'iconv-lite'

import { workerPool } from './worker-pool'

export interface DiffOptions {
  context?: number
}
export interface ReadLargeOptions {
  encoding?: string
  maxBytes?: number
}
export async function computeDiff(
  before: string,
  after: string,
  options: DiffOptions = {},
): Promise<string> {
  try {
    return (await workerPool.call('fs', 'fs.diff', { before, after, ...options })) as string
  } catch {
    return before === after
      ? ''
      : createTwoFilesPatch('before', 'after', before, after, '', '', {
          context: options.context ?? 3,
        })
  }
}
export async function countTokens(text: string, model: string): Promise<number> {
  try {
    return (await workerPool.call('fs', 'fs.count_tokens', { text, model })) as number
  } catch {
    // gpt-tokenizer uses cl100k_base. This fallback is exact for that encoding;
    // model-specific encodings may differ and are disclosed by native availability.
    return encode(text).length
  }
}
export async function readLarge(path: string, options: ReadLargeOptions = {}): Promise<string> {
  try {
    return (await workerPool.call('fs', 'fs.read_large', { path, ...options })) as string
  } catch {
    const bytes = await fs.readFile(path)
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024
    if (bytes.byteLength > maxBytes) throw new Error(`file exceeds read limit of ${maxBytes} bytes`)
    if (bytes.subarray(0, 8192).includes(0)) throw new Error('binary file is not supported')
    return iconv.decode(bytes, options.encoding ?? 'utf8')
  }
}
