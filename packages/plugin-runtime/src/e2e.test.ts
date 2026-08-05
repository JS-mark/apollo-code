import { access, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ToolSpec } from '@apollo-code/plugin-sdk'
import { afterAll, describe, expect, it } from 'vitest'

import { BridgeRuntime, PluginManager, PluginRuntime } from './index'

const run = process.env.APOLLO_RUN_PLUGIN_E2E === '1' ? describe : describe.skip
const fixtures: string[] = []
afterAll(async () => {
  await Promise.all(fixtures.map((path) => rm(path, { recursive: true, force: true })))
})

run('sandboxed community plugin E2E', () => {
  it('installs, activates, invokes, disables, enables, and uninstalls through the real host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'apollo-plugin-e2e-'))
    fixtures.push(root)
    const source = join(root, 'source')
    await cp(resolve('../../examples/community-plugin'), source, { recursive: true })
    const manager = new PluginManager(join(root, 'plugins'), '0.0.0', async () => true)
    await manager.init()
    const manifest = await manager.install(source)
    let tool: ToolSpec | undefined
    const bridge = new BridgeRuntime({
      session: { id: 'e2e', cwd: root, messages: [], usage: { inputTokens: 0, outputTokens: 0 } },
      register: (kind, value) => {
        if (kind === 'tool') tool = value as ToolSpec
        return {
          dispose: () => {
            tool = undefined
          },
        }
      },
      fs: {
        readFile: (path) => readFile(path, 'utf8'),
        writeFile,
        exists: async (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        glob: async () => [],
        stat: async (path) => {
          const value = await stat(path)
          return { size: value.size }
        },
      },
      exec: async () => ({}),
      fetch: async () => ({}),
      ui: () => undefined,
      storage: async () => undefined,
      config: () => undefined,
      log: () => undefined,
    })
    const runtime = new PluginRuntime(manager, bridge, { dataRoot: join(root, 'data') })
    await runtime.loadEnabled()
    expect(tool?.name).toBe('plugin:apollo-plugin-community-example:community.echo')
    await expect(tool!.handler({ text: 'sandboxed' }, {})).resolves.toEqual({
      content: [{ type: 'text', text: 'sandboxed' }],
    })
    await runtime.setEnabled(manifest.name, false)
    expect(tool).toBeUndefined()
    await runtime.setEnabled(manifest.name, true)
    expect(tool?.name).toContain('community.echo')
    await runtime.uninstall(manifest.name)
    expect(tool).toBeUndefined()
    await expect(access(join(manager.root, manifest.name))).rejects.toThrow()

    await manager.install(source)
    await writeFile(
      join(manager.root, manifest.name, manifest.main),
      'export async function activate(',
    )
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(runtime.load(manifest.name)).rejects.toThrow()
    expect(manager.list()[manifest.name]?.enabled).toBe(false)
    await runtime.uninstall(manifest.name)
  })
})
