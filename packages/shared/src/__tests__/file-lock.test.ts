import { spawn } from 'node:child_process'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireFileLock } from '../file-lock'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'volund-file-lock-'))
  dirs.push(dir)
  return dir
}

/** A pid guaranteed to be dead: spawn a child, wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((done) => child.on('exit', () => done()))
  if (child.pid === undefined) throw new Error('failed to spawn throwaway process')
  return child.pid
}

describe('acquireFileLock（公共 mutation 端口，SAG-12）', () => {
  it('acquire → release → 再 acquire；释放后锁文件移除', async () => {
    const dir = await fixture()
    const lockPath = join(dir, 'target.ts.volundlock')
    const release = await acquireFileLock(lockPath, 'session-1')
    const release2 = acquireFileLock(lockPath, 'session-2')
    await expect(release2).rejects.toThrow(/locked by another volund session/)
    await release()
    const release3 = await acquireFileLock(lockPath, 'session-2')
    await release3()
  }, 15_000)

  it('stale 回收：holder pid 已死 + 锁龄超阈值 → 立即抢占', async () => {
    const dir = await fixture()
    const lockPath = join(dir, 'target.ts.volundlock')
    await writeFile(lockPath, `${await deadPid()} session-gone\n`)
    const past = new Date(Date.now() - 120_000)
    await utimes(lockPath, past, past)
    const release = await acquireFileLock(lockPath, 'session-new')
    await release()
  })

  it('活进程持有（即使锁龄超阈值）→ 不抢占，重试耗尽抛带 pid 的冲突', async () => {
    const dir = await fixture()
    const lockPath = join(dir, 'target.ts.volundlock')
    // 用本测试进程自己的 pid：必然存活，且回收路径必须拒绝。
    await writeFile(lockPath, `${process.pid} session-live\n`)
    const past = new Date(Date.now() - 120_000)
    await utimes(lockPath, past, past)
    await expect(acquireFileLock(lockPath, 'session-other')).rejects.toThrow(
      new RegExp(`pid ${process.pid}`),
    )
    // 冲突后原锁未被破坏（保守：不误删活进程的锁）。
    await expect(acquireFileLock(lockPath, 'session-other-2')).rejects.toThrow(/locked by/)
  }, 15_000)
})
