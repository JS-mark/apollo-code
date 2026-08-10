import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DefaultMemoryService,
  LocalMemoryRepository,
  MemoryError,
  type MemoryRecord,
  type MemoryRecordScope,
  type MemoryRepository,
} from './memory-runtime'

const roots: string[] = []
const workspace = { kind: 'workspace', workspaceId: 'ws' } as const
const project = { kind: 'project', workspaceId: 'ws', projectId: 'apollo' } as const
const otherProject = { kind: 'project', workspaceId: 'ws', projectId: 'other' } as const
const session = {
  kind: 'session',
  workspaceId: 'ws',
  projectId: 'apollo',
  sessionId: 'session-1',
} as const

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function snapshotPath() {
  const root = await mkdtemp(join(tmpdir(), 'apollo-memory-runtime-'))
  roots.push(root)
  return join(root, 'memory', 'records.json')
}

function input(scope: MemoryRecordScope, content = 'Use pnpm') {
  return {
    scope,
    content,
    provenance: { source: 'user' as const, actorId: 'alice' },
    tags: [' tooling ', 'tooling'],
    pinned: true,
  }
}

describe('DefaultMemoryService', () => {
  it('freezes record metadata and keeps workspace, project, and session reads isolated', async () => {
    const service = new DefaultMemoryService(new LocalMemoryRepository(await snapshotPath()))
    await service.create({ ...input(workspace), id: 'workspace' })
    await service.create({ ...input(project), id: 'project' })
    await service.create({ ...input(session), id: 'session' })

    expect((await service.list(workspace)).map(({ id }) => id)).toEqual(['workspace'])
    expect((await service.list(project)).map(({ id }) => id)).toEqual(['project'])
    expect((await service.list(otherProject)).map(({ id }) => id)).toEqual([])
    expect((await service.list(session)).map(({ id }) => id)).toEqual(['session'])
    expect(await service.get(otherProject, 'project')).toBeUndefined()
    expect((await service.get(project, 'project'))?.tags).toEqual(['tooling'])
  })

  it('persists updates and soft deletes across a restart', async () => {
    const file = await snapshotPath()
    const first = new DefaultMemoryService(
      new LocalMemoryRepository(file),
      undefined,
      () => new Date(1),
    )
    await first.create({ ...input(project), id: 'preference' })
    await first.update(project, 'preference', { content: 'Use pnpm 11', pinned: false })
    await first.delete(project, 'preference')
    await first.flush()

    const restarted = new DefaultMemoryService(new LocalMemoryRepository(file))
    expect(await restarted.list(project)).toEqual([])
    expect(await restarted.list(project, { includeDeleted: true })).toMatchObject([
      { id: 'preference', content: 'Use pnpm 11', pinned: false, deletedAt: expect.any(String) },
    ])
  })

  it('rolls in-memory state back and returns a stable error after a disk failure', async () => {
    let fail = false
    const records: MemoryRecord[] = []
    const repository: MemoryRepository = {
      load: async () => records,
      save: async (next) => {
        if (fail) throw new Error('disk full')
        records.splice(0, records.length, ...next)
      },
      flush: async () => {},
    }
    const service = new DefaultMemoryService(repository)
    await service.create({ ...input(project), id: 'safe' })
    fail = true
    await expect(service.update(project, 'safe', { content: 'lost' })).rejects.toMatchObject({
      code: 'memory_io',
    })
    expect((await service.get(project, 'safe'))?.content).toBe('Use pnpm')
  })
})

describe('LocalMemoryRepository contract', () => {
  it('recovers the last durable snapshot after a corrupt primary', async () => {
    const file = await snapshotPath()
    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await service.create({ ...input(project), id: 'one' })
    await service.create({ ...input(project), id: 'two' })
    await writeFile(file, '{interrupted', 'utf8')

    const recovered = new DefaultMemoryService(new LocalMemoryRepository(file))
    expect((await recovered.list(project)).map(({ id }) => id)).toEqual(['one'])
  })

  it('does not replace the existing snapshot when interrupted before rename', async () => {
    const file = await snapshotPath()
    const service = new DefaultMemoryService(new LocalMemoryRepository(file))
    await service.create({ ...input(project), id: 'safe' })
    const interrupted = new DefaultMemoryService(
      new LocalMemoryRepository(file, {
        beforeRename: () => {
          throw new Error('simulated interruption')
        },
      }),
    )
    await expect(interrupted.create({ ...input(project), id: 'unsafe' })).rejects.toBeInstanceOf(
      MemoryError,
    )
    expect(JSON.parse(await readFile(file, 'utf8')).records).toMatchObject([{ id: 'safe' }])
  })

  it('rejects unsupported schemas with a stable corruption error', async () => {
    const file = await snapshotPath()
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({ schemaVersion: 999, records: [] }), 'utf8')
    await expect(new LocalMemoryRepository(file).load()).rejects.toMatchObject({
      code: 'memory_corrupt',
    })
  })
})
