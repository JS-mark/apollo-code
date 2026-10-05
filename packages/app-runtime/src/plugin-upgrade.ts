/**
 * 插件升级编排（§11.3.7 `volund plugin upgrade <name|--all>`）：跨两个可升级
 * 通道比对并重装——
 * - market：`~/.volund/plugins/<name>/`（volund-market.json）× 市场索引版本；
 * - github：`~/.volund/plugins-dev/<name>/`（volund-source.json）× 最新
 *   Release 资产名版本。
 * 本地 .volund 安装与 dev 软链无升级通道（重跑 install/dev 即可），静默跳过。
 * 逐插件隔离失败：单通道/单插件出错不影响其余行。
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PluginError } from '@volund/plugin-runtime'

import {
  installFromGithub,
  isNewerVersion,
  readGithubSourceMetadata,
  resolveGithubLatestVersion,
} from './plugin-github'
import {
  fetchMarketIndex,
  installFromMarket,
  marketInstallRoot,
  readMarketMetadata,
  readMarketSource,
} from './plugin-market'

export interface PluginUpgradeRow {
  readonly channel: 'market' | 'github'
  readonly name: string
  readonly from: string
  readonly to?: string
  readonly status: 'upgraded' | 'current' | 'unresolved' | 'failed'
  readonly detail?: string
}

export interface UpgradePluginsOptions {
  readonly home: string
  readonly volundVersion: string
  /** 指定插件名（跨通道）；缺省 = 全部可升级插件。 */
  readonly names?: readonly string[]
  signal?: AbortSignal
}

function wanted(names: readonly string[] | undefined): Set<string> | undefined {
  return names === undefined ? undefined : new Set(names)
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function upgradeGithubChannel(
  options: UpgradePluginsOptions,
  names: readonly string[] | undefined,
): Promise<readonly PluginUpgradeRow[]> {
  const devRoot = join(options.home, 'plugins-dev')
  let dirs: string[]
  try {
    dirs = await readdir(devRoot, { withFileTypes: true }).then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    )
  } catch {
    return []
  }
  const keep = wanted(names)
  const rows: PluginUpgradeRow[] = []
  for (const name of dirs) {
    if (keep && !keep.has(name)) continue
    const metadata = await readGithubSourceMetadata(join(devRoot, name)).catch(() => undefined)
    if (!metadata || !metadata.source.startsWith('github:')) continue
    const base = { channel: 'github' as const, name, from: metadata.version }
    try {
      const latest = await resolveGithubLatestVersion({
        spec: metadata.source,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (latest.version === undefined || !isNewerVersion(latest.version, metadata.version)) {
        rows.push({ ...base, status: 'current' })
        continue
      }
      const installed = await installFromGithub({
        home: options.home,
        spec: metadata.source,
        volundVersion: options.volundVersion,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      rows.push({ ...base, to: installed.version, status: 'upgraded' })
    } catch (error) {
      rows.push({ ...base, status: 'failed', detail: failureDetail(error) })
    }
  }
  return rows
}

async function upgradeMarketChannel(
  options: UpgradePluginsOptions,
  names: readonly string[] | undefined,
): Promise<readonly PluginUpgradeRow[]> {
  const root = marketInstallRoot(options.home)
  let dirs: string[]
  try {
    dirs = await readdir(root, { withFileTypes: true }).then((entries) =>
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    )
  } catch {
    return []
  }
  const installed: { name: string; version: string }[] = []
  for (const name of dirs) {
    const metadata = await readMarketMetadata(join(root, name)).catch(() => undefined)
    if (metadata) installed.push({ name: metadata.name, version: metadata.version })
  }
  if (installed.length === 0) return []
  const keep = wanted(names)
  const scoped = installed.filter((entry) => !keep || keep.has(entry.name))
  const source = await readMarketSource(options.home)
  if (!source)
    return scoped.map((entry) => ({
      channel: 'market' as const,
      name: entry.name,
      from: entry.version,
      status: 'unresolved' as const,
      detail: 'no [plugins] market source configured',
    }))
  let index: Awaited<ReturnType<typeof fetchMarketIndex>> | undefined
  try {
    index = await fetchMarketIndex(source, ...(options.signal ? [options.signal] : []))
  } catch {
    index = undefined
  }
  if (!index)
    return scoped.map((entry) => ({
      channel: 'market' as const,
      name: entry.name,
      from: entry.version,
      status: 'failed' as const,
      detail: 'market index unavailable',
    }))
  const entries = new Map(index.plugins.map((entry) => [entry.name, entry]))
  const rows: PluginUpgradeRow[] = []
  for (const entry of scoped) {
    const target = entries.get(entry.name)
    const base = { channel: 'market' as const, name: entry.name, from: entry.version }
    if (!target) {
      rows.push({ ...base, status: 'unresolved', detail: 'not in market index' })
      continue
    }
    try {
      if (!isNewerVersion(target.version, entry.version)) {
        rows.push({ ...base, status: 'current' })
        continue
      }
      const result = await installFromMarket({
        home: options.home,
        source,
        entry: target,
        volundVersion: options.volundVersion,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      rows.push({ ...base, to: result.version, status: 'upgraded' })
    } catch (error) {
      rows.push({ ...base, status: 'failed', detail: failureDetail(error) })
    }
  }
  return rows
}

/** 汇总两通道升级面；指定 names 中无任何归属时补 unresolved 行（可发现性）。 */
export async function upgradePlugins(
  options: UpgradePluginsOptions,
): Promise<readonly PluginUpgradeRow[]> {
  const names = options.names?.length ? options.names : undefined
  const rows = [
    ...(await upgradeGithubChannel(options, names)),
    ...(await upgradeMarketChannel(options, names)),
  ]
  if (names !== undefined) {
    const seen = new Set(rows.map((row) => row.name))
    for (const name of names) {
      if (!seen.has(name))
        rows.push({
          channel: 'market',
          name,
          from: '-',
          status: 'unresolved',
          detail: 'not installed from an upgradable channel (market / github)',
        })
    }
  }
  return rows
}
