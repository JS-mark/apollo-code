import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import type { EvolutionNamespace, EvolutionPersistence, EvolutionRecord } from '@apollo-code/core'
import { EVOLUTION_DEFAULTS } from '@apollo-code/core'
import { sanitize } from '@apollo-code/shared'

export class EvolutionStore implements EvolutionPersistence {
  #writeQueue = Promise.resolve()
  constructor(readonly root: string) {}
  async current(namespace: EvolutionNamespace) {
    const values: Partial<Record<string, number>> = {}
    for (const record of await this.readNamespace(namespace)) values[record.param] = record.after
    return values
  }
  async append(record: EvolutionRecord): Promise<void> {
    const clean = sanitize(record)
    const write = this.#writeQueue.then(async () => {
      await this.appendLine(join(this.root, `${record.namespace}.jsonl`), clean)
      await this.appendLine(join(this.root, 'audit.jsonl'), clean)
    })
    this.#writeQueue = write.catch(() => {})
    await write
  }
  async audit(namespace?: string, since?: Date): Promise<EvolutionRecord[]> {
    return (await this.read(join(this.root, 'audit.jsonl'))).filter(
      (record) =>
        (!namespace || record.namespace === namespace) && (!since || new Date(record.at) >= since),
    )
  }
  async rollback(namespace: EvolutionNamespace = 'context', to?: Date): Promise<EvolutionRecord[]> {
    const history = await this.readNamespace(namespace)
    const eligible = to
      ? history.filter((record) => new Date(record.at) <= to)
      : history.slice(0, -1)
    const current = await this.current(namespace)
    const target: Partial<Record<string, number>> = {}
    for (const record of eligible) target[record.param] = record.after
    const records: EvolutionRecord[] = []
    for (const [param, before] of Object.entries(current)) {
      if (before === undefined) continue
      const after =
        target[param] ?? (EVOLUTION_DEFAULTS[namespace] as Record<string, number>)[param]
      if (after === undefined) continue
      if (after === before) continue
      const record: EvolutionRecord = {
        namespace,
        param,
        before,
        after,
        at: new Date().toISOString(),
        reason: 'manual rollback',
        signal: {},
        action: 'rolled_back',
      }
      await this.append(record)
      records.push(record)
    }
    return records
  }
  private async appendLine(path: string, value: EvolutionRecord) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'a', 0o600)
    try {
      await file.write(`${JSON.stringify(value)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private readNamespace(namespace: string) {
    return this.read(join(this.root, `${namespace}.jsonl`))
  }
  private async read(path: string): Promise<EvolutionRecord[]> {
    const output: EvolutionRecord[] = []
    try {
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        try {
          output.push(JSON.parse(line) as EvolutionRecord)
        } catch {
          /* recover valid prefix/suffix around corrupt lines */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return output
  }
}

export interface TuningMemory {
  id: string
  scope: 'tuning'
  source: 'evolution'
  title: string
  body: string
  tags: string[]
  created: string
  updated: string
}
export class TuningMemoryStore {
  constructor(readonly root: string) {}
  async write(input: {
    id: string
    title: string
    body: string
    tags?: string[]
  }): Promise<TuningMemory> {
    const now = new Date().toISOString()
    const memory = sanitize({
      ...input,
      tags: input.tags ?? [],
      scope: 'tuning' as const,
      source: 'evolution' as const,
      created: now,
      updated: now,
    })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, `${input.id}.json`), JSON.stringify(memory, null, 2), {
      mode: 0o600,
    })
    return memory
  }
  async read(id: string): Promise<TuningMemory> {
    return JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')) as TuningMemory
  }
}
