/**
 * 跨进程 per-path 文件锁——storage/tools/workbench 共用的公共 mutation 端口
 * （SAG-12，spec §2.7bis.3 入口 C）。约定：锁文件 `<path>.volundlock`（storage
 * 的 manifest 锁用 `<path>.lock`，由调用方拼路径），内容为 `<pid> <owner>`。
 *
 * 冲突处理（SAG-05 语义，此处为唯一实现）：EEXIST 时先试 stale 回收——holder
 * pid 已死（ESRCH；EPERM 视为存活）且锁龄超阈值双条件才抢占，活进程永不抢占、
 * 无法解析的锁文件保守放过；然后按 1s 退避重试，重试耗尽抛带 pid 的可读冲突。
 */
import { open, readFile, rm, stat } from 'node:fs/promises'

const REAP_AGE_MS = 60_000
const MAX_ATTEMPTS = 4
const RETRY_DELAY_MS = 1_000

async function conflictMessage(lockPath: string): Promise<string> {
  const holder = await readFile(lockPath, 'utf8').catch(() => '')
  const pid = /^\s*(\d+)/.exec(holder)?.[1]
  return `file locked by another volund session${pid ? ` (pid ${pid})` : ''}, retry later`
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  const holder = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (holder === undefined) return false
  const pidText = /^\s*(\d+)/.exec(holder)?.[1]
  const pid = pidText ? Number(pidText) : Number.NaN
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false // holder alive — never preempt a live process
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
  }
  const ageMs = await stat(lockPath)
    .then((info) => Date.now() - info.mtimeMs)
    .catch(() => Number.NaN)
  if (!Number.isFinite(ageMs) || ageMs < REAP_AGE_MS) return false
  await rm(lockPath, { force: true })
  return true
}

export async function acquireFileLock(
  lockPath: string,
  owner: string,
): Promise<() => Promise<void>> {
  let attempt = 0
  let reapsLeft = 2
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid} ${owner}\n`)
      return async () => {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Stale-lock reaping: retry immediately without burning an attempt.
      if (reapsLeft > 0 && (await reapStaleLock(lockPath))) {
        reapsLeft--
        continue
      }
      if (attempt === MAX_ATTEMPTS - 1)
        throw new Error(await conflictMessage(lockPath), { cause: error })
      attempt++
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS))
    }
  }
}
