import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { probeSandbox, resolveBinary } from '@volund/native-bridge'
import { activateLocalPlugin, type ActivatedLocalPlugin } from '@volund/plugin-runtime'
import type { Tool } from '@volund/tool-kit'
import { afterEach, describe, expect, it } from 'vitest'

import { createPluginHookDispatcher } from './runtime'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const exampleDir = join(repoRoot, 'examples', 'plugins', 'volund-plugin-demo')
const tsExampleDir = join(repoRoot, 'examples', 'plugins', 'volund-plugin-ts-demo')

const dirs: string[] = []
const handles: ActivatedLocalPlugin[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.deactivate()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sandboxAvailable(): Promise<boolean> {
  if (!process.env.VOLUND_NATIVE_SANDBOX_BINARY)
    process.env.VOLUND_NATIVE_SANDBOX_BINARY = join(repoRoot, 'target', 'debug', 'volund-sandbox')
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    return (await probeSandbox()).tier !== 'none'
  } catch {
    return false
  }
}

async function activateExample() {
  const dataDir = await mkdtemp(join(tmpdir(), 'volund-example-data-'))
  dirs.push(dataDir)
  const activated = await activateLocalPlugin({
    dir: exampleDir,
    volundVersion: '0.1.0',
    dataDirRoot: dataDir,
    services: {},
  })
  handles.push(activated)
  return activated
}

describe('volund-plugin-demo（示例插件 = 全贡献面可运行文档）', () => {
  it('activates through the sandbox and registers every contribution kind', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    expect(activated.manifest.name).toBe('volund-plugin-demo')
    expect(activated.tools.map((tool) => tool.name)).toEqual([
      'plugin:volund-plugin-demo:word-count',
    ])
    // session.on 复用 hooks 订阅通道：sessionStart 也是一条 hook 记录
    expect(activated.hooks.map((hook) => hook.event)).toEqual(['preToolUse', 'sessionStart'])
    expect(activated.prompts).toHaveLength(1)
    expect(activated.commands.find((command) => command.name === 'demo')).toBeDefined()
  }, 30_000)

  it('invokes the word-count tool with structured output', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const tool = activated.tools[0]!
    expect(tool.description).toContain('Count words')
    const raw = (await tool.invoke({ text: 'a b\ncd' })) as {
      words: number
      characters: number
      lines: number
    }
    expect(raw).toEqual({ words: 3, characters: 6, lines: 2 })
  }, 30_000)

  it('veto hook blocks matching Bash calls through the kernel dispatcher', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const dispatcher = createPluginHookDispatcher(
      [{ name: activated.manifest.name, handle: activated }],
      { warn: () => {} },
    )
    const outcome = await dispatcher(
      'preToolUse',
      {
        schemaVersion: 1,
        tool: 'Bash',
        input: { command: 'echo demo-block-me' },
      },
      { signal: new AbortController().signal },
    )
    expect(outcome).toMatchObject({ veto: true })
    expect(outcome?.reason).toContain('demo-block-me')
    const pass = await dispatcher(
      'preToolUse',
      {
        schemaVersion: 1,
        tool: 'Bash',
        input: { command: 'git status' },
      },
      { signal: new AbortController().signal },
    )
    expect(pass).toBeUndefined()
  }, 30_000)

  it('renders the /demo command as a pure-data list view', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const command = activated.commands.find((candidate) => candidate.name === 'demo')
    const output = (await command!.run([])) as { kind: string; entries: unknown[] }
    expect(output.kind).toBe('list')
    expect(output.entries).toHaveLength(4)
  }, 30_000)

  it('keeps the example a valid plugin:* namespaced tool for kernel registration', () => {
    // 与 ToolRegistry {kind:'plugin'} 的名字约束对齐——示例漂移即测试失败。
    const probe: Pick<Tool, 'name'> = { name: 'plugin:volund-plugin-demo:word-count' }
    expect(probe.name.startsWith('plugin:volund-plugin-demo:')).toBe(true)
  })
})

describe('TS 插件入口（strip-types）', () => {
  async function tsPluginFixture() {
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-plugin-tsdata-'))
    dirs.push(dataDir)
    const activated = await activateLocalPlugin({
      dir: tsExampleDir,
      volundVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: {},
    })
    handles.push(activated)
    return activated
  }

  it('loads a TypeScript entry and its tool works across the bridge', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await tsPluginFixture()
    expect(activated.manifest.main).toBe('index.ts')
    const tool = activated.tools.find(
      (candidate) => candidate.name === 'plugin:volund-plugin-ts-demo:ts-count',
    )
    expect(tool).toBeDefined()
    const raw = (await tool!.invoke({ text: 'a b c' })) as { words: number; chars: number }
    expect(raw).toEqual({ words: 3, characters: 5, lines: 1 })
  }, 30_000)
})

/* ── volund-plugin-task-notify（W-17 r1.5 任务终态 webhook 示例）────────────── */

const taskNotifyDir = join(repoRoot, 'examples', 'plugins', 'volund-plugin-task-notify')

interface FakeHook {
  event: string
  handler: (payload: unknown) => Promise<unknown>
}

interface FakeCommandSpec {
  name: string
  handler(args: readonly string[]): Promise<string>
}

function taskNotifyBridge() {
  const store = new Map<string, unknown>()
  const fetches: { url: string; init?: Record<string, unknown> }[] = []
  const hooks: FakeHook[] = []
  let command: FakeCommandSpec | undefined
  const volund = {
    hooks: {
      on: (event: string, handler: (payload: unknown) => Promise<unknown>) => {
        hooks.push({ event, handler })
        return { dispose() {} }
      },
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, value)
      },
    },
    commands: {
      register: async (spec: FakeCommandSpec) => {
        command = spec
      },
    },
    http: {
      fetch: async (url: string, init?: Record<string, unknown>) => {
        fetches.push(init ? { url, init } : { url })
        return { status: 200 }
      },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return { volund, store, fetches, hooks, command: () => command }
}

describe('volund-plugin-task-notify（任务终态 webhook 通知示例）', () => {
  const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 1,
    sessionId: 'sess-1',
    taskId: 'nightly',
    runId: 'run-abc123',
    scheduledFor: 1_700_000_000_000,
    ...overrides,
  })

  async function activated() {
    const module = (await import(pathToFileURL(join(taskNotifyDir, 'index.ts')).href)) as {
      activate(volund: unknown): Promise<void>
    }
    const bridge = taskNotifyBridge()
    await module.activate(bridge.volund)
    return bridge
  }

  it('registers both terminal hooks and the /task-notify command', async () => {
    const bridge = await activated()
    expect(bridge.hooks.map((hook) => hook.event)).toEqual(['task.completed', 'task.failed'])
    expect(bridge.command()?.name).toBe('task-notify')
  })

  it('stays silent without config, routes by task then default, shapes bodies per host', async () => {
    const bridge = await activated()
    const [completed, failed] = bridge.hooks
    // 未配置：不出网
    await completed!.handler(payload())
    expect(bridge.fetches).toHaveLength(0)

    await bridge.command()!.handler(['https://hooks.example.com/default'])
    await bridge.command()!.handler(['nightly', 'https://oapi.dingtalk.com/robot/send?token=x'])
    expect(bridge.store.get('notify-config')).toEqual({
      defaultUrl: 'https://hooks.example.com/default',
      routes: { nightly: 'https://oapi.dingtalk.com/robot/send?token=x' },
    })

    // 单任务路由 + 钉钉体
    await completed!.handler(payload({ durationMs: 1500 }))
    expect(bridge.fetches).toHaveLength(1)
    expect(bridge.fetches[0]?.url).toBe('https://oapi.dingtalk.com/robot/send?token=x')
    expect(bridge.fetches[0]?.init?.['body']).toEqual({
      msgtype: 'text',
      text: { content: '✅ 定时任务 nightly 运行完成（run run-abc1，耗时 1.5s）' },
    })

    // 其余任务走默认接收端 + 通用体（含 reason）
    await failed!.handler(
      payload({ taskId: 'other', runId: 'run-xyz', durationMs: 500, reason: 'error' }),
    )
    expect(bridge.fetches).toHaveLength(2)
    expect(bridge.fetches[1]?.url).toBe('https://hooks.example.com/default')
    expect(bridge.fetches[1]?.init?.['body']).toMatchObject({
      event: 'task.failed',
      taskId: 'other',
      reason: 'error',
      text: expect.stringContaining('❌ 定时任务 other 运行失败'),
    })
  })

  it('command supports status / remove / off', async () => {
    const bridge = await activated()
    const command = bridge.command()!
    expect(await command.handler([])).toContain('未配置')
    await command.handler(['https://hooks.example.com/default'])
    await command.handler(['nightly', 'https://hooks.example.com/nightly'])
    expect(await command.handler([])).toContain('nightly → https://hooks.example.com/nightly')
    expect(await command.handler(['remove', 'missing'])).toContain('没有 missing')
    expect(await command.handler(['remove', 'nightly'])).toContain('已删除')
    expect(await command.handler(['off'])).toContain('已清空')
    expect(bridge.store.get('notify-config')).toEqual({})
  })

  it('activates through the sandbox with hooks and command contributions', async () => {
    if (!(await sandboxAvailable())) return
    const dataDir = await mkdtemp(join(tmpdir(), 'volund-task-notify-'))
    dirs.push(dataDir)
    const activatedPlugin = await activateLocalPlugin({
      dir: taskNotifyDir,
      volundVersion: '0.1.0',
      dataDirRoot: dataDir,
      services: {},
    })
    handles.push(activatedPlugin)
    expect(activatedPlugin.hooks.map((hook) => hook.event)).toEqual([
      'task.completed',
      'task.failed',
    ])
    expect(activatedPlugin.commands.find((command) => command.name === 'task-notify')).toBeDefined()
  }, 30_000)
})
