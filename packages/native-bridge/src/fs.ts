import { promises as fs } from 'node:fs'

import { workerPool } from './worker-pool'

export async function computeDiff(before: string, after: string): Promise<string> {
  try {
    return (await workerPool.call('fs', 'fs.diff', { before, after })) as string
  } catch {
    return before === after ? '' : `--- before\n+++ after\n@@\n-${before}\n+${after}\n`
  }
}
export async function countTokens(text: string, model: string): Promise<number> {
  try {
    return (await workerPool.call('fs', 'fs.count_tokens', { text, model })) as number
  } catch {
    return text.trim() ? text.trim().split(/\s+/u).length : 0
  }
}
export async function readLarge(path: string): Promise<string> {
  try {
    return (await workerPool.call('fs', 'fs.read_large', { path })) as string
  } catch {
    return fs.readFile(path, 'utf8')
  }
}
