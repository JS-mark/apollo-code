import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const cli = new URL('../apps/cli/dist/volund.js', import.meta.url)

async function run(args, home, cwd = path.dirname(cli.pathname)) {
  try {
    const result = await execute(process.execPath, [cli.pathname, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        VOLUND_HOME: home,
        NO_COLOR: '1',
      },
    })
    return { code: 0, ...result }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

void test('task scheduler lifecycle: add → daemon catch-up fire → journal (W-17 F1)', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'volund-l1-tasks-'))
  // validateWorkspacePath 拒绝 /tmp（unsafe workspace），工作区放 home 下。
  const ws = path.join(os.homedir(), `volund-l1-ws-${path.basename(home)}`)
  try {
    await rm(ws, { force: true, recursive: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(ws, { recursive: true })
    await writeFile(path.join(home, 'config.toml'), '[tasks]\nenabled = true\n')
    // trust 文件直写（与 DirectoryTrustStore 文档形状一致；realpath 对齐 canonicalize）。
    await writeFile(
      path.join(home, 'trusted-directories.json'),
      JSON.stringify({
        version: 1,
        rules: [{ path: await realpath(ws), scope: 'tree', trustedAt: new Date().toISOString() }],
      }),
    )

    const added = await run(
      [
        'tasks',
        'add',
        '--name',
        'E2E',
        '--prompt',
        'e2e smoke',
        '--schedule',
        'interval:1m',
        '--missed',
        'run_latest',
        '--cwd',
        ws,
      ],
      home,
    )
    assert.equal(added.code, 0, added.stderr)

    // backdate createdAt → daemon 首 tick 的 run_latest 立即补跑。
    const storePath = path.join(home, 'tasks.json')
    const store = JSON.parse(await readFile(storePath, 'utf8'))
    store.tasks[0].createdAt = Date.now() - 10 * 60 * 1000
    await writeFile(storePath, JSON.stringify(store))

    const child = spawn(process.execPath, [cli.pathname, 'daemon'], {
      env: { PATH: process.env.PATH, VOLUND_HOME: home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      let daemonStdout = ''
      child.stdout.on('data', (chunk) => {
        daemonStdout += String(chunk)
      })
      // 首 tick 立即补跑；子进程无 provider 凭据会快速失败入账。
      let journaled = ''
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(1000)
        const runs = await run(['tasks', 'runs', 'e2e'], home)
        if (/failed|completed/.test(runs.stdout)) {
          journaled = runs.stdout
          break
        }
      }
      assert.match(daemonStdout, /volund daemon started/)
      assert.match(daemonStdout, /1 fired/)
      assert.match(journaled, /failed|completed/)

      // 单实例：第二个 daemon 拒启（task_daemon_running）。
      const second = await run(['daemon'], home)
      assert.equal(second.code, 1)
      assert.match(second.stderr, /task_daemon_running|another volund daemon/)
    } finally {
      child.kill('SIGTERM')
      await sleep(500)
    }
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
    await rm(ws, { recursive: true, force: true }).catch(() => undefined)
  }
})

void test('built CLI exposes honest no-secret JSON and no-TUI roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'volund-l1-e2e-'))
  try {
    const status = await run(['status', '--json'], home)
    assert.equal(status.code, 0)
    assert.equal(status.stderr, '')
    const snapshot = JSON.parse(status.stdout)
    assert.ok(Array.isArray(snapshot.status))
    assert.ok(
      snapshot.status.some(
        (row) => row.label === 'Auth method' && row.value === 'credential store (value hidden)',
      ),
    )

    const missingPrompt = await run(['chat', '--json', '--no-tui'], home)
    assert.equal(missingPrompt.code, 2)
    const records = missingPrompt.stdout.trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      records.map(({ type, data }) => ({ type, data })),
      [
        {
          type: 'error',
          data: {
            code: 'prompt_required',
            category: 'usage',
            retryable: false,
            exitCode: 2,
            message: 'JSON chat requires a prompt.',
          },
        },
        { type: 'final', data: { status: 'error', exitCode: 2 } },
      ],
    )
    assert.equal(missingPrompt.stderr, '')

    const persisted = await readFile(path.join(home, 'telemetry', 'events.jsonl'), 'utf8').catch(
      () => '',
    )
    assert.doesNotMatch(`${status.stdout}${persisted}`, /api[_-]?key|bearer\s|secret/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
