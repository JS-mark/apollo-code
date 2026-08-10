import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const MEMORY_RECORD_SCHEMA_VERSION = 1 as const
const SNAPSHOT_SCHEMA_VERSION = 1 as const

export type MemoryRecordScope =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'project'; readonly workspaceId: string; readonly projectId: string }
  | {
      readonly kind: 'session'
      readonly workspaceId: string
      readonly projectId: string
      readonly sessionId: string
    }

export interface MemoryProvenance {
  readonly source: 'user' | 'agent' | 'evolution' | 'import'
  readonly actorId?: string
  readonly sourceId?: string
}

export interface MemoryRecord {
  readonly schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION
  readonly id: string
  readonly scope: MemoryRecordScope
  readonly content: string
  readonly provenance: MemoryProvenance
  readonly tags: readonly string[]
  readonly pinned: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
}

export type NewMemoryRecord = Pick<MemoryRecord, 'scope' | 'content' | 'provenance'> & {
  readonly id?: string
  readonly tags?: readonly string[]
  readonly pinned?: boolean
}

export type MemoryErrorCode =
  | 'memory_conflict'
  | 'memory_corrupt'
  | 'memory_io'
  | 'memory_not_found'
  | 'memory_scope_denied'
  | 'memory_validation'

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MemoryError'
  }
}

export interface MemoryRepository {
  load(): Promise<readonly MemoryRecord[]>
  save(records: readonly MemoryRecord[]): Promise<void>
  flush(): Promise<void>
}

export interface MemoryPolicy {
  canAccess(requested: MemoryRecordScope, record: MemoryRecordScope): boolean
}

export interface MemoryService {
  start(): Promise<void>
  create(input: NewMemoryRecord): Promise<MemoryRecord>
  get(scope: MemoryRecordScope, id: string): Promise<MemoryRecord | undefined>
  list(scope: MemoryRecordScope, options?: { includeDeleted?: boolean }): Promise<MemoryRecord[]>
  update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'pinned'>>,
  ): Promise<MemoryRecord>
  delete(scope: MemoryRecordScope, id: string): Promise<MemoryRecord>
  flush(): Promise<void>
}

export class HierarchicalMemoryPolicy implements MemoryPolicy {
  canAccess(requested: MemoryRecordScope, record: MemoryRecordScope): boolean {
    if (requested.workspaceId !== record.workspaceId || requested.kind !== record.kind) return false
    if (requested.kind === 'workspace' || record.kind === 'workspace') return true
    if (requested.projectId !== record.projectId) return false
    if (requested.kind === 'project' || record.kind === 'project') return true
    return requested.sessionId === record.sessionId
  }
}

function validateScope(scope: MemoryRecordScope): void {
  if (!scope.workspaceId) throw new MemoryError('memory_validation', 'workspaceId is required')
  if (scope.kind !== 'workspace' && !scope.projectId)
    throw new MemoryError('memory_validation', 'projectId is required')
  if (scope.kind === 'session' && !scope.sessionId)
    throw new MemoryError('memory_validation', 'sessionId is required')
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
  if (normalized.some((tag) => tag.length > 64))
    throw new MemoryError('memory_validation', 'Memory tags must not exceed 64 characters')
  return normalized.toSorted()
}

export class DefaultMemoryService implements MemoryService {
  readonly #records = new Map<string, MemoryRecord>()
  #started = false
  #mutation = Promise.resolve()

  constructor(
    readonly repository: MemoryRepository,
    readonly policy: MemoryPolicy = new HierarchicalMemoryPolicy(),
    readonly now: () => Date = () => new Date(),
    readonly createId: () => string = randomUUID,
  ) {}

  async start(): Promise<void> {
    if (this.#started) return
    for (const record of await this.repository.load()) this.#records.set(record.id, record)
    this.#started = true
  }

  async create(input: NewMemoryRecord): Promise<MemoryRecord> {
    validateScope(input.scope)
    if (!input.content.trim()) throw new MemoryError('memory_validation', 'Memory content is empty')
    return this.#write(async () => {
      const id = input.id ?? this.createId()
      if (this.#records.has(id)) throw new MemoryError('memory_conflict', `Memory ${id} exists`)
      const now = this.now().toISOString()
      const record: MemoryRecord = {
        schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
        id,
        scope: input.scope,
        content: input.content,
        provenance: input.provenance,
        tags: normalizeTags(input.tags ?? []),
        pinned: input.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }
      this.#records.set(id, record)
      return record
    })
  }

  async get(scope: MemoryRecordScope, id: string): Promise<MemoryRecord | undefined> {
    await this.start()
    const record = this.#records.get(id)
    return record && this.policy.canAccess(scope, record.scope) ? record : undefined
  }

  async list(
    scope: MemoryRecordScope,
    options: { includeDeleted?: boolean } = {},
  ): Promise<MemoryRecord[]> {
    await this.start()
    return [...this.#records.values()]
      .filter(
        (record) =>
          this.policy.canAccess(scope, record.scope) &&
          (options.includeDeleted || !record.deletedAt),
      )
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  async update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'pinned'>>,
  ): Promise<MemoryRecord> {
    return this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) throw new MemoryError('memory_not_found', `Memory ${id} is deleted`)
      if (patch.content !== undefined && !patch.content.trim())
        throw new MemoryError('memory_validation', 'Memory content is empty')
      const record: MemoryRecord = {
        ...current,
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.tags === undefined ? {} : { tags: normalizeTags(patch.tags) }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        updatedAt: this.now().toISOString(),
      }
      this.#records.set(id, record)
      return record
    })
  }

  async delete(scope: MemoryRecordScope, id: string): Promise<MemoryRecord> {
    return this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) return current
      const now = this.now().toISOString()
      const record = { ...current, pinned: false, updatedAt: now, deletedAt: now }
      this.#records.set(id, record)
      return record
    })
  }

  async flush(): Promise<void> {
    await this.#mutation
    await this.repository.flush()
  }

  #require(scope: MemoryRecordScope, id: string): MemoryRecord {
    const record = this.#records.get(id)
    if (!record || !this.policy.canAccess(scope, record.scope))
      throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
    return record
  }

  async #write<T>(mutation: () => Promise<T>): Promise<T> {
    await this.start()
    const operation = this.#mutation.then(async () => {
      const before = new Map(this.#records)
      try {
        const result = await mutation()
        await this.repository.save([...this.#records.values()])
        return result
      } catch (error) {
        this.#records.clear()
        for (const [id, record] of before) this.#records.set(id, record)
        if (error instanceof MemoryError) throw error
        throw new MemoryError('memory_io', 'Unable to persist memory', { cause: error })
      }
    })
    this.#mutation = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
}

interface MemorySnapshotV1 {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  readonly records: readonly MemoryRecord[]
}

export interface LocalMemoryRepositoryOptions {
  beforeRename?: (temporaryPath: string, destinationPath: string) => void | Promise<void>
}

/** Atomic snapshot adapter. A previous .bak is retained until the new snapshot is durable. */
export class LocalMemoryRepository implements MemoryRepository {
  constructor(
    readonly path: string,
    readonly options: LocalMemoryRepositoryOptions = {},
  ) {}

  async load(): Promise<readonly MemoryRecord[]> {
    const primary = await this.#read(this.path)
    if (primary.ok) return primary.records
    const backup = await this.#read(`${this.path}.bak`)
    if (backup.ok) return backup.records
    if (primary.missing && backup.missing) return []
    throw new MemoryError('memory_corrupt', 'Memory snapshot and recovery backup are unreadable', {
      cause: primary.error ?? backup.error,
    })
  }

  async save(records: readonly MemoryRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, records }))
      await file.sync()
    } catch (error) {
      await file.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await file.close()
    try {
      await rm(`${this.path}.bak`, { force: true })
      await rename(this.path, `${this.path}.bak`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await this.options.beforeRename?.(temporary, this.path)
      await rename(temporary, this.path)
      // Windows does not support fsync on directory handles and returns EPERM.
      // The snapshot file itself is still synced before the atomic rename above.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      await rename(`${this.path}.bak`, this.path).catch(() => undefined)
      throw error
    }
  }

  async flush(): Promise<void> {
    // save() fsyncs the file and, where supported, its containing directory.
  }

  async #read(
    path: string,
  ): Promise<
    | { ok: true; records: readonly MemoryRecord[]; missing?: false; error?: undefined }
    | { ok: false; missing: boolean; error: unknown }
  > {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      return { ok: true, records: migrateSnapshot(raw) }
    } catch (error) {
      return { ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', error }
    }
  }
}

function migrateSnapshot(value: unknown): readonly MemoryRecord[] {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid memory snapshot')
  const snapshot = value as Partial<MemorySnapshotV1>
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(snapshot.records))
    throw new TypeError('Unsupported memory snapshot schema')
  for (const record of snapshot.records) {
    if (record.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
      throw new TypeError(`Unsupported memory record schema: ${String(record.schemaVersion)}`)
    }
    validateScope(record.scope)
  }
  return snapshot.records
}
