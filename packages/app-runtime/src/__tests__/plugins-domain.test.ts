import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildVolundArchive } from '../plugin-archive'
import { broadcastPluginLifecycleHook, collectBuiltinCandidates } from '../plugins-domain'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** broadcast 是 void 派发：让出微任务让 reject 的 catch 落地。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Recorded {
  name: string
  event: string
  payload: unknown
}

function pluginEntry(
  name: string,
  events: readonly string[],
  recorded: Recorded[],
  fail = false,
): {
  name: string
  handle?: {
    hooks: readonly { event: string; plugin: string; invoke(payload: unknown): Promise<unknown> }[]
  }
} {
  return {
    name,
    handle: {
      hooks: events.map((event) => ({
        event,
        plugin: name,
        invoke: (payload: unknown) => {
          recorded.push({ name, event, payload })
          if (fail) return Promise.reject(new Error('boom'))
          return Promise.resolve(undefined)
        },
      })),
    },
  }
}

describe('broadcastPluginLifecycleHook', () => {
  it('maps session lifecycle events to sessionStart/sessionEnd with envelope payload', () => {
    const recorded: Recorded[] = []
    broadcastPluginLifecycleHook(
      { type: 'session.started', sessionId: 's1', payload: {} },
      [pluginEntry('p', ['sessionStart', 'sessionEnd'], recorded)],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      { type: 'session.ended', sessionId: 's1', payload: {} },
      [pluginEntry('p', ['sessionStart', 'sessionEnd'], recorded)],
      { warn: () => undefined },
    )
    expect(recorded).toEqual([
      { name: 'p', event: 'sessionStart', payload: { schemaVersion: 1, sessionId: 's1' } },
      { name: 'p', event: 'sessionEnd', payload: { schemaVersion: 1, sessionId: 's1' } },
    ])
  })

  it('passes task terminal events through by name with payload + sessionId (W-17 r1.5)', () => {
    const recorded: Recorded[] = []
    const subscriber = pluginEntry(
      'relay',
      ['task.started', 'task.completed', 'task.failed'],
      recorded,
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.started',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1 },
      },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.completed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5 },
      },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      {
        type: 'task.failed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5, reason: 'error' },
      },
      [subscriber],
      { warn: () => undefined },
    )
    expect(recorded.map((row) => row.event)).toEqual([
      'task.started',
      'task.completed',
      'task.failed',
    ])
    expect(recorded[1]?.payload).toEqual({
      schemaVersion: 1,
      sessionId: 's1',
      taskId: 'job',
      runId: 'r1',
      scheduledFor: 1,
      durationMs: 5,
    })
  })

  it('ignores unrelated events and non-object task payloads stay envelope-only', () => {
    const recorded: Recorded[] = []
    const subscriber = pluginEntry('p', ['task.completed', 'sessionStart'], recorded)
    broadcastPluginLifecycleHook(
      { type: 'turn.completed', sessionId: 's1', payload: {} },
      [subscriber],
      { warn: () => undefined },
    )
    broadcastPluginLifecycleHook(
      { type: 'task.completed', sessionId: 's1', payload: null },
      [subscriber],
      { warn: () => undefined },
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.payload).toEqual({ schemaVersion: 1, sessionId: 's1' })
  })

  it('is fail-open: a throwing handler warns but does not affect other subscribers', async () => {
    const recorded: Recorded[] = []
    const warns: string[] = []
    broadcastPluginLifecycleHook(
      {
        type: 'task.completed',
        sessionId: 's1',
        payload: { taskId: 'job', runId: 'r1', scheduledFor: 1, durationMs: 5 },
      },
      [
        pluginEntry('bad', ['task.completed'], recorded, true),
        pluginEntry('good', ['task.completed'], recorded),
      ],
      { warn: (message) => warns.push(message) },
    )
    await flush()
    expect(recorded.map((row) => row.name)).toEqual(['bad', 'good'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('plugin hook task.completed from bad failed')
  })
})

/* ── collectBuiltinCandidates（r1.6 内置插件 .volund 化）────────────────────── */

describe('collectBuiltinCandidates', () => {
  async function writeManifest(dir: string, name: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ name, version: '0.1.0', type: 'module', main: 'index.mjs' }),
    )
    await writeFile(join(dir, 'index.mjs'), 'export async function activate() {}\n')
  }

  it('collects directory form and unpacks .volund form, rejects name mismatches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-builtin-root-'))
    const cacheRoot = await mkdtemp(join(tmpdir(), 'volund-builtin-cache-'))
    dirs.push(root, cacheRoot)

    // 目录形态（dev 源码态）
    await writeManifest(join(root, 'volund-plugin-dirform'), 'volund-plugin-dirform')
    // .volund 形态：先落一个合法目录再打包
    const packable = join(root, 'stage-volund-plugin-packed')
    await writeManifest(packable, 'volund-plugin-packed')
    const pack = await buildVolundArchive(packable)
    await rm(packable, { recursive: true, force: true })
    await writeFile(join(root, 'volund-plugin-packed.volund'), pack.bytes)
    // 名字不匹配的包
    const mismatch = join(root, 'stage-volund-plugin-other')
    await writeManifest(mismatch, 'volund-plugin-other')
    const otherPack = await buildVolundArchive(mismatch)
    await rm(mismatch, { recursive: true, force: true })
    await writeFile(join(root, 'volund-plugin-wrongname.volund'), otherPack.bytes)
    // 无关文件
    await writeFile(join(root, 'README.md'), 'not a plugin')

    const { candidates, failed } = await collectBuiltinCandidates(root, cacheRoot)
    expect(candidates).toContain(join(root, 'volund-plugin-dirform'))
    expect(candidates).toContain(join(cacheRoot, 'volund-plugin-packed'))
    expect(
      join(cacheRoot, 'volund-plugin-packed') &&
        existsSync(join(cacheRoot, 'volund-plugin-packed', 'index.mjs')),
    ).toBe(true)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.dir).toBe(join(root, 'volund-plugin-wrongname.volund'))
  })

  it('tolerates a missing root', async () => {
    const { candidates, failed } = await collectBuiltinCandidates(
      '/nonexistent-volund-builtin-root',
      '/nonexistent-volund-builtin-cache',
    )
    expect(candidates).toEqual([])
    expect(failed).toEqual([])
  })
})
