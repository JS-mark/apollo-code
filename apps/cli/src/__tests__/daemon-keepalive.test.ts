import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../cli'
import type { VolundPorts } from '../ports'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const plistPath = join(repoRoot, 'deploy/daemon/cc.nexo.volund.daemon.plist')
const unitPath = join(repoRoot, 'deploy/daemon/volund-daemon.service')
const designDocPath = join(
  repoRoot,
  'docs/superpowers/specs/2026-07-31-volund-code-design/W17-scheduler-design.md',
)

describe('daemon keep-alive assets (W-17 OS 保活)', () => {
  it('ships a launchd agent that only respawns on abnormal exit', async () => {
    const plist = await readFile(plistPath, 'utf8')
    expect(plist).toContain('<key>Label</key><string>cc.nexo.volund.daemon</string>')
    // launchd 只负责让 `volund daemon` 活着，不参与调度（F1-01 单实现铁律）。
    expect(plist).toMatch(/<string>\/usr\/local\/bin\/volund<\/string><string>daemon<\/string>/)
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    // 保活语义的核心：SuccessfulExit=false——开关关闭的 exit 0 不空转。
    expect(plist).toMatch(/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/>/)
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
  })

  it('ships a systemd user unit that restarts only on failure', async () => {
    const unit = await readFile(unitPath, 'utf8')
    expect(unit).toMatch(/^ExecStart=.*\bvolund daemon$/m)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('RestartSec=')
    expect(unit).toMatch(/^\[Install\]$/m)
    expect(unit).toContain('WantedBy=default.target')
  })

  it('keeps the design doc supervisor samples in sync with the shipped assets', async () => {
    // 样板出处是 W17 设计文档；两边语义键必须同时在场，防止单侧静默漂移。
    const doc = await readFile(designDocPath, 'utf8')
    expect(doc).toContain('cc.nexo.volund.daemon')
    expect(doc).toContain('<key>SuccessfulExit</key><false/>')
    expect(doc).toContain('Restart=on-failure')
    expect(doc).toContain('WantedBy=default.target')
  })

  it('cold start with the scheduler disabled exits non-zero (documented keep-alive precondition)', async () => {
    // 保活前置：先 enabled = true 再装保活；冷启动未启用 = exit 1（tasks_disabled），
    // 会被保活重拉——这是文档化行为而非回归。热关闭（运行中翻 false）的 exit 0
    // 不空转契约由 daemon.test.ts 的 onDisabled / stopped:'disabled' 用例锁定。
    const ports = {
      identity: { version: '0.0.0-test' },
      config: {
        listMerged: vi.fn(async () => ({
          config: { tasks: { enabled: false } },
          warnings: [],
        })),
      },
    } as unknown as VolundPorts
    const result = await runCli(['daemon'], ports)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Task scheduler is disabled')
    expect(result.stderr).toContain('[tasks].enabled')
  })
})
