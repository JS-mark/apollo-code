import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import type { PluginSandboxProfile } from '@apollo-code/native-bridge'
import type { PluginManifest } from '@apollo-code/plugin-sdk'
import type {
  Disposable as ProviderDisposable,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  ProviderRegistry,
  ProviderRequest,
} from '@apollo-code/provider-kit'

export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export interface PluginApproval {
  version: string
  permissionHash: string
  enabled: boolean
  failures?: number
}
export interface PluginState {
  approvals: Record<string, PluginApproval>
}
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
const RANGE = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/
export function satisfies(version: string, range: string): boolean {
  const v = VERSION.exec(version),
    r = RANGE.exec(range)
  if (!v || !r) return false
  const [major, minor, patch] = v.slice(1, 4).map(Number),
    [rMajor, rMinor, rPatch] = r.slice(2, 5).map(Number)
  if (major !== rMajor) return false
  if (!r[1]) return minor === rMinor && patch === rPatch
  if (r[1] === '~') return minor === rMinor && patch! >= rPatch!
  return major === 0
    ? minor === rMinor && patch! >= rPatch!
    : minor! > rMinor! || (minor === rMinor && patch! >= rPatch!)
}
const safeRelative = (value: string) => !isAbsolute(value) && !value.split(/[\\/]/).includes('..')
export function validateManifest(value: unknown, apolloVersion: string): PluginManifest {
  if (!value || typeof value !== 'object')
    throw new PluginError('plugin_manifest_invalid', 'manifest must be an object')
  const m = value as Partial<PluginManifest>
  if (
    !m.name?.startsWith('apollo-plugin-') ||
    !VERSION.test(m.version ?? '') ||
    m.type !== 'module' ||
    !m.main ||
    !safeRelative(m.main)
  )
    throw new PluginError('plugin_manifest_invalid', 'invalid name, version, type, or main path')
  if (!m.engines?.apollo || !satisfies(apolloVersion, m.engines.apollo))
    throw new PluginError(
      'plugin_engine_incompatible',
      `Apollo ${apolloVersion} does not satisfy ${m.engines?.apollo ?? '(missing)'}`,
    )
  if (!m.permissions || !Array.isArray(m.permissions.apollo))
    throw new PluginError('plugin_manifest_invalid', 'permissions.apollo is required')
  if (m.kind === 'provider') {
    const provider = m.provider
    if (
      !provider?.name ||
      !provider.displayName ||
      provider.auth?.mode !== 'header-template' ||
      !provider.auth.credentialScope ||
      !provider.auth.headerTemplate?.includes('{{key}}')
    )
      throw new PluginError('plugin_provider_invalid', 'invalid header-template provider')
    if (!m.permissions.net || m.permissions.net.allowlist.length === 0)
      throw new PluginError('plugin_provider_net_required', 'provider requires a net allowlist')
    for (const permission of ['provider.register', 'auth.getAuthHeaders'])
      if (!m.permissions.apollo.includes(permission))
        throw new PluginError('plugin_provider_permission_required', permission)
  } else if (m.provider) {
    throw new PluginError('plugin_provider_invalid', 'provider section requires kind: provider')
  }
  return m as PluginManifest
}
export const permissionHash = (manifest: PluginManifest) =>
  createHash('sha256').update(JSON.stringify(manifest.permissions)).digest('hex')
export function sandboxProfile(
  manifest: PluginManifest,
  pluginDir: string,
  dataDir: string,
): PluginSandboxProfile {
  const fs = manifest.permissions.fs
  return {
    fs: {
      read: [pluginDir, ...(fs?.read ?? []).map((path) => resolve(pluginDir, path))],
      write: [dataDir, ...(fs?.write ?? []).map((path) => resolve(dataDir, path))],
    },
    net: manifest.permissions.net ? { allowlist: [...manifest.permissions.net.allowlist] } : false,
    env: { read: ['PATH', 'HOME', 'LANG'] },
    limits: { cpu_seconds: 30, rss_mb: 256, processes: 1, open_files: 64 },
  }
}
export async function verifyBundle(
  pluginDir: string,
  manifest: PluginManifest,
  integrity?: Record<string, string>,
) {
  const root = await realpath(pluginDir)
  for (const entry of [manifest.main, ...Object.keys(integrity ?? {})]) {
    if (!safeRelative(entry))
      throw new PluginError('plugin_path_escape', `unsafe bundle path: ${entry}`)
    const path = resolve(root, entry)
    if ((await lstat(path)).isSymbolicLink())
      throw new PluginError('plugin_symlink_rejected', `symlink rejected: ${entry}`)
    const resolved = await realpath(path)
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      throw new PluginError('plugin_path_escape', `bundle path escapes plugin: ${entry}`)
    const expected = integrity?.[entry]
    if (expected) {
      const actual = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      if (actual !== expected.replace(/^sha256-/, ''))
        throw new PluginError('plugin_integrity_failed', `integrity mismatch: ${entry}`)
    }
  }
}
export class PluginManager {
  private state: PluginState = { approvals: {} }
  constructor(
    readonly root: string,
    readonly apolloVersion: string,
    readonly confirm: (manifest: PluginManifest, expanded: boolean) => Promise<boolean>,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true })
    try {
      this.state = JSON.parse(
        await readFile(join(this.root, 'plugins.json'), 'utf8'),
      ) as PluginState
    } catch {}
  }
  private async save() {
    const temp = join(this.root, `.plugins-${process.pid}.tmp`)
    await writeFile(temp, JSON.stringify(this.state, null, 2))
    await rename(temp, join(this.root, 'plugins.json'))
  }
  async inspect(dir: string) {
    const manifest = validateManifest(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
      this.apolloVersion,
    )
    await verifyBundle(dir, manifest)
    return manifest
  }
  async install(source: string) {
    const manifest = await this.inspect(source),
      destination = join(this.root, manifest.name),
      temp = join(this.root, `.${manifest.name}-${process.pid}.install`)
    await rm(temp, { recursive: true, force: true })
    await cp(source, temp, { recursive: true, dereference: false, verbatimSymlinks: true })
    await verifyBundle(temp, manifest)
    const old = this.state.approvals[manifest.name],
      hash = permissionHash(manifest),
      expanded = Boolean(old && old.permissionHash !== hash)
    if (!old || expanded)
      if (!(await this.confirm(manifest, expanded))) {
        await rm(temp, { recursive: true, force: true })
        throw new PluginError('plugin_permission_denied', 'plugin permissions were not approved')
      }
    const backup = `${destination}.rollback`
    await rm(backup, { recursive: true, force: true })
    try {
      await rename(destination, backup)
    } catch {}
    try {
      await rename(temp, destination)
      await rm(backup, { recursive: true, force: true })
    } catch (error) {
      try {
        await rename(backup, destination)
      } catch {}
      throw error
    }
    this.state.approvals[manifest.name] = {
      version: manifest.version,
      permissionHash: hash,
      enabled: true,
      failures: 0,
    }
    await this.save()
    return manifest
  }
  async setEnabled(name: string, enabled: boolean) {
    const record = this.state.approvals[name]
    if (!record) throw new PluginError('plugin_not_installed', name)
    record.enabled = enabled
    record.failures = 0
    await this.save()
  }
  async recordFailure(name: string, threshold = 3) {
    const record = this.state.approvals[name]
    if (!record) return false
    record.failures = (record.failures ?? 0) + 1
    if (record.failures >= threshold) record.enabled = false
    await this.save()
    return !record.enabled
  }
  async uninstall(name: string) {
    if (basename(name) !== name) throw new PluginError('plugin_path_escape', name)
    await rm(join(this.root, name), { recursive: true, force: true })
    delete this.state.approvals[name]
    await this.save()
  }
  list() {
    return structuredClone(this.state.approvals)
  }
}
export function createRpcGuard(manifest: PluginManifest, maxCallsPerTurn = 500) {
  const allowed = new Set(manifest.permissions.apollo),
    calls = new Map<string, number>()
  return (turnId: string, method: string) => {
    if (!allowed.has(method)) throw new PluginError('plugin_rpc_method_denied', method)
    const count = (calls.get(turnId) ?? 0) + 1
    calls.set(turnId, count)
    if (count > maxCallsPerTurn) throw new PluginError('plugin_rpc_quota_exceeded', method)
  }
}

export type CredentialReader = (scope: string) => Promise<string | undefined>

export function renderAuthHeaders(template: string, key: string): Record<string, string> {
  const separator = template.indexOf(':')
  if (separator < 1)
    throw new PluginError('plugin_auth_template_invalid', 'missing header separator')
  const name = template.slice(0, separator).trim()
  const value = template
    .slice(separator + 1)
    .trim()
    .replaceAll('{{key}}', key)
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))
    throw new PluginError('plugin_auth_template_invalid', 'invalid header name or value')
  return { [name]: value }
}

export interface ProviderStreamTransport {
  stream(
    providerName: string,
    request: ProviderRequest & { authHeaders: Record<string, string> },
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk>
  dispose(): Promise<void>
}

export function registerProviderPlugin(options: {
  manifest: PluginManifest
  capabilities: ProviderCapabilities
  registry: ProviderRegistry
  credentials: CredentialReader
  transport: ProviderStreamTransport
}): ProviderDisposable {
  const { manifest, capabilities, registry, credentials, transport } = options
  if (manifest.kind !== 'provider' || !manifest.provider)
    throw new PluginError('plugin_provider_invalid', 'not a provider plugin')
  const provider = manifest.provider
  const client: ProviderClient = {
    name: provider.name,
    capabilities: Object.freeze(structuredClone(capabilities)),
    async *stream(request, signal) {
      const key = await credentials(provider.auth.credentialScope)
      const authHeaders = key ? renderAuthHeaders(provider.auth.headerTemplate, key) : {}
      yield* transport.stream(provider.name, { ...request, authHeaders }, signal)
    },
    dispose: () => transport.dispose(),
  }
  const meta = {
    capabilities: client.capabilities,
    displayName: provider.displayName,
    ...(provider.models ? { models: provider.models } : {}),
  }
  return registry.register(client, { kind: 'plugin', plugin: manifest.name }, meta)
}

export class BufferedProviderStream {
  private bytes = 0
  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}
  accept(chunk: ProviderChunk) {
    this.bytes += Buffer.byteLength(JSON.stringify(chunk))
    if (this.bytes > this.maxBytes)
      throw new PluginError('stream_truncated', 'provider stream buffer exceeded')
    return chunk
  }
  consume(chunk: ProviderChunk) {
    this.bytes = Math.max(0, this.bytes - Buffer.byteLength(JSON.stringify(chunk)))
  }
}
