import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { DefaultPromptComposer } from '@apollo-code/core'
import { PermissionManager } from '@apollo-code/permission'
import { afterEach, describe, expect, it } from 'vitest'

import { AttachmentStore, BackupStore, PromptLoader, SessionStore } from './index'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function temp() {
  const dir = await mkdtemp(resolve(tmpdir(), 'apollo-storage-'))
  dirs.push(dir)
  return dir
}
describe('SessionStore', () => {
  it('writes v first, skips deltas, fsyncs append-only records', async () => {
    const dir = await temp(),
      path = resolve(dir, 's.jsonl'),
      store = new SessionStore(path)
    await store.appendCore({
      id: '1',
      type: 'stream.delta',
      version: 1,
      sessionId: 's',
      payload: {},
      at: 0,
    })
    await store.append({
      v: 1,
      id: '2',
      type: 'message.appended',
      sessionId: 's',
      at: 'now',
      payload: { text: 'ok' },
    })
    const line = await readFile(path, 'utf8')
    expect(line.startsWith('{"v":1')).toBe(true)
    expect(line).not.toContain('stream.delta')
  })
  it('rejects inline attachment bytes', async () => {
    const store = new SessionStore(resolve(await temp(), 's.jsonl'))
    await expect(
      store.append({
        v: 1,
        id: 'x',
        type: 'x',
        sessionId: 's',
        at: '',
        payload: { bytes: new Uint8Array([1]) } as never,
      }),
    ).rejects.toThrow('Binary')
  })
  it('persists and resumes attachment handles without binary data', async () => {
    const path = resolve(await temp(), 's.jsonl')
    const store = new SessionStore(path)
    await store.append({
      v: 1,
      id: 'image',
      type: 'session.snapshot',
      sessionId: 's',
      at: 'now',
      payload: {
        content: [
          {
            type: 'image',
            mime: 'image/png',
            source: { kind: 'handle', handle: `${'a'.repeat(64)}.png` },
          },
        ],
      },
    })
    expect(await store.resume()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ content: [expect.objectContaining({ type: 'image' })] }),
      }),
    ])
    expect(await readFile(path, 'utf8')).not.toContain('bytes')
  })
})
describe('AttachmentStore', () => {
  it('stages content-addressed images and reloads handle references', async () => {
    const dir = await temp()
    const store = new AttachmentStore(resolve(dir, 'attachments'))
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const staged = await store.stage(bytes, 'image/png')
    expect(staged.handle).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(await store.read({ kind: 'handle', handle: staged.handle })).toEqual(bytes)
    expect(
      await new AttachmentStore(resolve(dir, 'attachments')).read({
        kind: 'handle',
        handle: staged.handle,
      }),
    ).toEqual(bytes)
  })
  it('rejects corrupt, unsupported, oversized, and forged handle inputs', async () => {
    const store = new AttachmentStore(resolve(await temp(), 'attachments'), 4)
    await expect(store.stage(Uint8Array.from([1]), 'image/png')).rejects.toThrow('match MIME')
    await expect(store.stage(Uint8Array.from([1]), 'image/svg+xml')).rejects.toThrow('Unsupported')
    await expect(
      store.stage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]), 'image/png'),
    ).rejects.toThrow('size limit')
    await expect(store.read({ kind: 'handle', handle: '../secret.png' })).rejects.toThrow('Invalid')
    await expect(store.read({ kind: 'path', absPath: import.meta.filename })).rejects.toThrow(
      'outside allowed roots',
    )
  })
})
describe('BackupStore', () => {
  it('restores the original version after repeated mutations and is idempotent', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(target, 'original')
    const first = await store.prepare('session-1', [target])
    await writeFile(target, 'one')
    await first.commit()
    const second = await store.prepare('session-1', [target])
    await writeFile(target, 'two')
    await second.commit()
    expect((await store.restore('session-1', { dryRun: true })).restored).toEqual([target])
    await store.restore('session-1')
    expect(await readFile(target, 'utf8')).toBe('original')
    expect((await store.restore('session-1')).conflicts).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('refuses conflicts and reports missing or corrupt manifests', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    expect((await store.restore('unknown')).missing).toBe(true)
    await writeFile(target, 'before')
    const transaction = await store.prepare('session-2', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    await writeFile(target, 'external change')
    expect((await store.restore('session-2')).conflicts).toEqual([target])
    await writeFile(resolve(dir, 'backups', 'session-2', 'manifest.json'), '{broken')
    await expect(store.restore('session-2')).rejects.toThrow('corrupt')
  })

  it('rolls back new and existing files when a mutation is interrupted', async () => {
    const dir = await temp(),
      existing = resolve(dir, 'existing.txt'),
      created = resolve(dir, 'created.txt'),
      store = new BackupStore(resolve(dir, 'backups'))
    await writeFile(existing, 'before')
    const transaction = await store.prepare('session-3', [existing, created])
    await writeFile(existing, 'partial')
    await writeFile(created, 'partial')
    await transaction.rollback()
    expect(await readFile(existing, 'utf8')).toBe('before')
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails before mutation when backup storage is unavailable and garbage-collects by size', async () => {
    const dir = await temp(),
      target = resolve(dir, 'project.txt'),
      invalidRoot = resolve(dir, 'not-a-directory')
    await writeFile(target, 'before')
    await writeFile(invalidRoot, 'file')
    await expect(new BackupStore(invalidRoot).prepare('session-4', [target])).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('before')

    const root = resolve(dir, 'gc'),
      store = new BackupStore(root, { maxBytes: 1 })
    const transaction = await store.prepare('session-5', [target])
    await writeFile(target, 'after')
    await transaction.commit()
    await expect(access(resolve(root, 'session-5'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
describe('PromptLoader', () => {
  it('loads AGENT over CLAUDE and expands safe includes', async () => {
    const dir = await temp()
    await writeFile(resolve(dir, 'AGENT.md'), '@include ./rules.md')
    await writeFile(resolve(dir, 'CLAUDE.md'), 'wrong')
    await writeFile(resolve(dir, 'rules.md'), 'rules')
    const permissions = new PermissionManager(),
      composer = new DefaultPromptComposer()
    await new PromptLoader({
      cwd: dir,
      apolloHome: resolve(dir, '.apollo'),
      permissions,
    }).registerProject(composer)
    const prompt = await composer.compose({ cwd: dir, model: 'm', provider: 'p' })
    expect(prompt).toContain('rules')
    expect(prompt).not.toContain('wrong')
  })
  it('leaves a denial placeholder for sensitive includes', async () => {
    const dir = await temp()
    await writeFile(resolve(dir, 'AGENT.md'), '@include ./.env.md')
    await writeFile(resolve(dir, '.env.md'), 'SECRET')
    const loader = new PromptLoader({
      cwd: dir,
      apolloHome: resolve(dir, '.apollo'),
      permissions: new PermissionManager(),
    })
    expect(await loader.load(resolve(dir, 'AGENT.md'))).toContain('DENIED (sensitive)')
  })
  it('recognizes Windows separators in sensitive include paths', async () => {
    const dir = await temp()
    const loader = new PromptLoader({
      cwd: dir,
      apolloHome: resolve(dir, '.apollo'),
      permissions: new PermissionManager(),
    })
    expect(await loader.load(`${dir.replaceAll('/', '\\')}\\.env.md`)).toContain(
      'DENIED (sensitive)',
    )
  })
})
