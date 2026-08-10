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

export interface MemoryListOptions {
  readonly includeDeleted?: boolean
  readonly limit?: number
  readonly cursor?: string
  readonly pinned?: boolean
  readonly tags?: readonly string[]
}

export interface MemoryPage {
  readonly items: MemoryRecord[]
  readonly nextCursor?: string
}

export interface MemoryMutationOptions {
  /** Optimistic concurrency token returned as `updatedAt` by every read. */
  readonly expectedUpdatedAt?: string
}

export interface MemoryPreWriteContext {
  readonly operation: 'create' | 'update'
  readonly scope: MemoryRecordScope
  readonly id: string
  readonly content: string
}

export type MemoryPreWrite = (context: MemoryPreWriteContext) => void | Promise<void>

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
  list(
    scope: MemoryRecordScope,
    options?: Omit<MemoryListOptions, 'cursor'>,
  ): Promise<MemoryRecord[]>
  listPage(scope: MemoryRecordScope, options?: MemoryListOptions): Promise<MemoryPage>
  update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'pinned'>>,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  delete(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
  pin(scope: MemoryRecordScope, id: string, options?: MemoryMutationOptions): Promise<MemoryRecord>
  unpin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord>
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
  if (!validIdentifier(scope.workspaceId))
    throw new MemoryError('memory_validation', 'workspaceId is invalid')
  if (scope.kind !== 'workspace' && !validIdentifier(scope.projectId))
    throw new MemoryError('memory_validation', 'projectId is invalid')
  if (scope.kind === 'session' && !validIdentifier(scope.sessionId))
    throw new MemoryError('memory_validation', 'sessionId is invalid')
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const secretPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/i
const MAX_MEMORY_CONTENT_BYTES = 64 * 1024

function validIdentifier(value: string): boolean {
  return identifierPattern.test(value) && value !== '.' && value !== '..'
}

function hasInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const low = value.charCodeAt(++index)
      if (low < 0xdc00 || low > 0xdfff) return true
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function builtinPreWrite(context: MemoryPreWriteContext): void {
  if (!validIdentifier(context.id))
    throw new MemoryError('memory_validation', 'Memory id is invalid')
  if (!context.content.trim()) throw new MemoryError('memory_validation', 'Memory content is empty')
  if (hasInvalidUnicode(context.content))
    throw new MemoryError('memory_validation', 'Memory content contains invalid Unicode')
  if (Buffer.byteLength(context.content, 'utf8') > MAX_MEMORY_CONTENT_BYTES)
    throw new MemoryError('memory_validation', 'Memory content exceeds 64 KiB')
  if (secretPattern.test(context.content))
    throw new MemoryError('memory_validation', 'Memory content appears to contain a secret')
}

function encodeCursor(record: MemoryRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.id]), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): readonly [string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value.some((item) => typeof item !== 'string')
    )
      throw new TypeError('invalid cursor')
    return value as unknown as readonly [string, string]
  } catch (error) {
    throw new MemoryError('memory_validation', 'Memory cursor is invalid', { cause: error })
  }
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
    readonly preWrite: MemoryPreWrite = async () => {},
  ) {}

  async start(): Promise<void> {
    if (this.#started) return
    for (const record of await this.repository.load()) this.#records.set(record.id, record)
    this.#started = true
  }

  async create(input: NewMemoryRecord): Promise<MemoryRecord> {
    validateScope(input.scope)
    return this.#write(async () => {
      const id = input.id ?? this.createId()
      const existing = this.#records.get(id)
      if (existing) {
        const tags = normalizeTags(input.tags ?? [])
        if (
          !existing.deletedAt &&
          this.policy.canAccess(input.scope, existing.scope) &&
          existing.content === input.content &&
          existing.pinned === (input.pinned ?? false) &&
          JSON.stringify(existing.tags) === JSON.stringify(tags) &&
          JSON.stringify(existing.provenance) === JSON.stringify(input.provenance)
        )
          return existing
        throw new MemoryError('memory_conflict', `Memory ${id} exists`)
      }
      await this.#runPreWrite({
        operation: 'create',
        scope: input.scope,
        id,
        content: input.content,
      })
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
    options: Omit<MemoryListOptions, 'cursor'> = {},
  ): Promise<MemoryRecord[]> {
    return (await this.listPage(scope, options)).items
  }

  async listPage(scope: MemoryRecordScope, options: MemoryListOptions = {}): Promise<MemoryPage> {
    await this.start()
    validateScope(scope)
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new MemoryError('memory_validation', 'Memory page limit must be between 1 and 500')
    const after = options.cursor ? decodeCursor(options.cursor) : undefined
    const tags = normalizeTags(options.tags ?? [])
    const records = [...this.#records.values()]
      .filter(
        (record) =>
          this.policy.canAccess(scope, record.scope) &&
          (options.includeDeleted || !record.deletedAt) &&
          (options.pinned === undefined || record.pinned === options.pinned) &&
          tags.every((tag) => record.tags.includes(tag)),
      )
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter(
        (record) =>
          !after ||
          record.createdAt > after[0] ||
          (record.createdAt === after[0] && record.id > after[1]),
      )
    const items = records.slice(0, limit)
    return {
      items,
      ...(records.length > limit && items.length
        ? { nextCursor: encodeCursor(items.at(-1)!) }
        : {}),
    }
  }

  async update(
    scope: MemoryRecordScope,
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'pinned'>>,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    return this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) throw new MemoryError('memory_not_found', `Memory ${id} is deleted`)
      this.#checkVersion(current, options)
      if (patch.content !== undefined)
        await this.#runPreWrite({ operation: 'update', scope, id, content: patch.content })
      const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags)
      const pinned = patch.pinned ?? current.pinned
      const content = patch.content ?? current.content
      if (
        content === current.content &&
        pinned === current.pinned &&
        JSON.stringify(tags) === JSON.stringify(current.tags)
      )
        return current
      const record: MemoryRecord = {
        ...current,
        content,
        tags,
        pinned,
        updatedAt: this.now().toISOString(),
      }
      this.#records.set(id, record)
      return record
    })
  }

  async delete(
    scope: MemoryRecordScope,
    id: string,
    options: MemoryMutationOptions = {},
  ): Promise<MemoryRecord> {
    return this.#write(async () => {
      const current = this.#require(scope, id)
      if (current.deletedAt) return current
      this.#checkVersion(current, options)
      const now = this.now().toISOString()
      const record = { ...current, pinned: false, updatedAt: now, deletedAt: now }
      this.#records.set(id, record)
      return record
    })
  }

  async pin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.update(scope, id, { pinned: true }, options)
  }

  async unpin(
    scope: MemoryRecordScope,
    id: string,
    options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    return this.update(scope, id, { pinned: false }, options)
  }

  async flush(): Promise<void> {
    await this.#mutation
    await this.repository.flush()
  }

  #require(scope: MemoryRecordScope, id: string): MemoryRecord {
    validateScope(scope)
    const record = this.#records.get(id)
    if (!record || !this.policy.canAccess(scope, record.scope))
      throw new MemoryError('memory_not_found', `Memory ${id} was not found`)
    return record
  }

  #checkVersion(record: MemoryRecord, options: MemoryMutationOptions): void {
    if (options.expectedUpdatedAt && record.updatedAt !== options.expectedUpdatedAt)
      throw new MemoryError('memory_conflict', `Memory ${record.id} changed concurrently`)
  }

  async #runPreWrite(context: MemoryPreWriteContext): Promise<void> {
    // The built-in guard is deliberately unconditional; injected hooks may add restrictions only.
    builtinPreWrite(context)
    try {
      await this.preWrite(context)
    } catch (error) {
      if (error instanceof MemoryError) throw error
      throw new MemoryError('memory_validation', 'memory.preWrite rejected the write', {
        cause: error,
      })
    }
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
