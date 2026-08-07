import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { startPluginHost } from '@apollo-code/native-bridge'
import type { PluginHost, PluginSandboxProfile } from '@apollo-code/native-bridge'
import type {
  ApolloBridge,
  Disposable,
  HookEvent,
  HookHandler,
  HookResult,
  PluginManifest,
  PluginUiContribution,
} from '@apollo-code/plugin-sdk'
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
    super(`${code}: ${message}`)
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
const UI_SURFACES = new Set(['status-bar'])
const UI_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || code === 127
  })
function validateUiContributions(manifest: Partial<PluginManifest>) {
  const contributions = manifest.contributes?.ui
  if (contributions === undefined) return
  if (!Array.isArray(contributions))
    throw new PluginError('plugin_ui_invalid', 'contributes.ui must be an array')
  if (!manifest.permissions?.apollo.includes('ui.contribute'))
    throw new PluginError('plugin_ui_permission_required', 'ui.contribute')
  const ids = new Set<string>()
  for (const item of contributions as readonly PluginUiContribution[]) {
    const keys = item && typeof item === 'object' ? Object.keys(item) : []
    if (
      !item ||
      typeof item !== 'object' ||
      keys.some((key) => !['id', 'surface', 'text', 'priority'].includes(key)) ||
      !UI_ID.test(item.id) ||
      !UI_SURFACES.has(item.surface) ||
      typeof item.text !== 'string' ||
      item.text.length === 0 ||
      item.text.length > 160 ||
      hasControlCharacter(item.text) ||
      (item.priority !== undefined &&
        (!Number.isSafeInteger(item.priority) || item.priority < -100 || item.priority > 100)) ||
      ids.has(item.id)
    )
      throw new PluginError(
        'plugin_ui_invalid',
        `invalid UI contribution: ${item?.id ?? '(unknown)'}`,
      )
    ids.add(item.id)
  }
}
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
  validateUiContributions(m)
  if (m.kind === 'provider') {
    const provider = m.provider
    if (
      !provider?.name ||
      !provider.displayName ||
      !provider.auth?.credentialScope ||
      !['header-template', 'signing'].includes(provider.auth.mode)
    )
      throw new PluginError('plugin_provider_invalid', 'invalid provider authentication')
    if (
      provider.auth.mode === 'header-template' &&
      !provider.auth.headerTemplate?.includes('{{key}}')
    )
      throw new PluginError('plugin_provider_invalid', 'invalid header-template provider')
    if (provider.auth.mode === 'signing') {
      const signing = provider.auth.signing
      if (
        !['aws-sigv4', 'acs3', 'custom'].includes(signing?.algorithm) ||
        !Array.isArray(signing?.envKeys) ||
        signing.envKeys.length === 0 ||
        new Set(signing.envKeys).size !== signing.envKeys.length ||
        signing.envKeys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))
      )
        throw new PluginError('plugin_provider_invalid', 'invalid signing provider')
    }
    if (!m.permissions.net || m.permissions.net.allowlist.length === 0)
      throw new PluginError('plugin_provider_net_required', 'provider requires a net allowlist')
    const authPermission =
      provider.auth.mode === 'signing' ? 'auth.getSigningEnvKeys' : 'auth.getAuthHeaders'
    for (const permission of ['provider.register', authPermission])
      if (!m.permissions.apollo.includes(permission))
        throw new PluginError('plugin_provider_permission_required', permission)
  } else if (m.provider) {
    throw new PluginError('plugin_provider_invalid', 'provider section requires kind: provider')
  }
  return m as PluginManifest
}
export const permissionHash = (manifest: PluginManifest) =>
  createHash('sha256')
    .update(
      JSON.stringify({ permissions: manifest.permissions, ui: manifest.contributes?.ui ?? [] }),
    )
    .digest('hex')
export function sandboxProfile(
  manifest: PluginManifest,
  pluginDir: string,
  dataDir: string,
): PluginSandboxProfile {
  const fs = manifest.permissions.fs
  const runtimeRoots = [dirname(process.execPath)]
  const homebrew = /^(.+)\/Cellar\/node\//.exec(process.execPath)?.[1]
  if (process.platform === 'darwin' && homebrew)
    runtimeRoots.push(join(homebrew, 'Cellar'), join(homebrew, 'etc', 'openssl@3'))
  return {
    fs: {
      read: [
        pluginDir,
        ...runtimeRoots,
        ...(fs?.read ?? []).map((path) => resolve(pluginDir, path)),
      ],
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

type RpcFrame = {
  jsonrpc: '2.0'
  bridgeVersion: 1
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}
const RPC_MAX_FRAME = 1024 * 1024
const RPC_METHODS = new Set([
  'tools.register',
  'tools.unregister',
  'hooks.on',
  'hooks.off',
  'hooks.kv.get',
  'hooks.kv.set',
  'hooks.kv.delete',
  'hooks.kv.clear',
  'commands.register',
  'prompt.contribute',
  'prompt.revoke',
  'session.getMessages',
  'session.getUsage',
  'session.on',
  'fs.readFile',
  'fs.writeFile',
  'fs.exists',
  'fs.glob',
  'fs.stat',
  'exec',
  'http.fetch',
  'ui.confirm',
  'ui.prompt',
  'ui.pick',
  'ui.notify',
  'storage.get',
  'storage.set',
  'storage.delete',
  'config.get',
  'log.debug',
  'log.info',
  'log.warn',
  'log.error',
  'call',
])

class PluginConnection {
  #buffer = ''
  #nextId = 1
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout }
  >()
  #activatedResolve!: () => void
  #activatedReject!: (error: Error) => void
  readonly activated = new Promise<void>((resolve, reject) => {
    this.#activatedResolve = resolve
    this.#activatedReject = reject
  })
  constructor(
    readonly process: PluginHost,
    readonly bridge: ApolloBridge,
    readonly timeoutMs: number,
  ) {
    void this.activated.catch(() => {})
    process.bridge.setEncoding('utf8')
    process.bridge.on('data', (chunk: string | Buffer) => this.onData(String(chunk)))
    process.bridge.on('error', (error) => this.fail(error))
    void process.exited.then(({ code, signal }) => {
      if (code !== 0 || signal)
        this.fail(new PluginError('plugin_host_exited', `code=${code} signal=${signal ?? 'none'}`))
    })
  }
  async invoke(callbackId: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason
    const id = this.#nextId++
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new PluginError('plugin_callback_timeout', callbackId))
      }, this.timeoutMs)
      this.#pending.set(id, { resolve, reject, timeout })
    })
    const abort = () =>
      this.rejectPending(id, new PluginError('plugin_callback_cancelled', callbackId))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.write({
        jsonrpc: '2.0',
        bridgeVersion: 1,
        id,
        method: 'callback.invoke',
        params: { callbackId, args },
      })
      return await result
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  dispose() {
    this.fail(new PluginError('plugin_deactivated', 'plugin connection closed'))
    this.process.terminate()
  }
  private onData(chunk: string) {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > RPC_MAX_FRAME) {
      this.process.terminate()
      return this.fail(new PluginError('plugin_rpc_frame_too_large', 'bridge frame exceeds limit'))
    }
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      let frame: RpcFrame
      try {
        frame = JSON.parse(line) as RpcFrame
      } catch {
        this.process.terminate()
        return this.fail(new PluginError('plugin_rpc_invalid_json', 'invalid bridge JSON'))
      }
      void this.dispatch(frame).catch((error: unknown) => {
        this.process.terminate()
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
    }
  }
  private async dispatch(frame: RpcFrame) {
    if (frame.jsonrpc !== '2.0' || frame.bridgeVersion !== 1) {
      this.process.terminate()
      return this.fail(new PluginError('plugin_rpc_version', 'unsupported bridge protocol'))
    }
    if (frame.id !== undefined && !frame.method) {
      const pending = this.#pending.get(frame.id)
      if (!pending) return
      this.#pending.delete(frame.id)
      clearTimeout(pending.timeout)
      if (frame.error)
        pending.reject(new PluginError('plugin_callback_failed', frame.error.message))
      else pending.resolve(frame.result)
      return
    }
    if (frame.method === 'host.ready') return
    if (frame.method === 'host.activated') return this.#activatedResolve()
    if (!frame.method || frame.id === undefined) return
    try {
      const result = await this.callBridge(frame.method, this.decode(frame.params))
      await this.write({ jsonrpc: '2.0', bridgeVersion: 1, id: frame.id, result })
    } catch (error) {
      await this.write({
        jsonrpc: '2.0',
        bridgeVersion: 1,
        id: frame.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  private decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.decode(item))
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.$callback === 'string')
        return (...args: unknown[]) => this.invoke(record.$callback as string, args)
      return Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, this.decode(item)]),
      )
    }
    return value
  }
  private async callBridge(method: string, params: unknown) {
    if (!method.startsWith('apollo.')) throw new PluginError('plugin_rpc_method_denied', method)
    const rpcPath = method.slice('apollo.'.length)
    if (!RPC_METHODS.has(rpcPath)) throw new PluginError('plugin_rpc_method_denied', method)
    const path = rpcPath.split('.')
    let target: unknown = this.bridge
    for (const part of path) target = (target as Record<string, unknown>)?.[part]
    if (typeof target !== 'function') throw new PluginError('plugin_rpc_method_denied', method)
    const result = await (target as (value: unknown) => unknown)(params)
    return result && typeof result === 'object' && 'dispose' in result ? {} : result
  }
  private async write(frame: RpcFrame) {
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line) > RPC_MAX_FRAME)
      throw new PluginError('plugin_rpc_frame_too_large', 'bridge frame exceeds limit')
    if (!this.process.bridge.write(line))
      await new Promise<void>((resolve) => this.process.bridge.once('drain', resolve))
  }
  private rejectPending(id: number, error: Error) {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(error)
  }
  private fail(error: Error) {
    this.#activatedReject(error)
    for (const id of this.#pending.keys()) this.rejectPending(id, error)
  }
}

export interface PluginRuntimeOptions {
  dataRoot: string
  activationTimeoutMs?: number
  start?: typeof startPluginHost
}
export class PluginRuntime {
  readonly #active = new Map<string, PluginConnection>()
  readonly #start: typeof startPluginHost
  readonly #activationTimeoutMs: number
  constructor(
    readonly manager: PluginManager,
    readonly bridge: BridgeRuntime,
    readonly options: PluginRuntimeOptions,
  ) {
    this.#start = options.start ?? startPluginHost
    this.#activationTimeoutMs = options.activationTimeoutMs ?? 10_000
  }
  async loadEnabled() {
    const failures: Array<{ name: string; error: Error }> = []
    for (const [name, approval] of Object.entries(this.manager.list())) {
      if (!approval.enabled) continue
      try {
        await this.load(name)
      } catch (error) {
        failures.push({ name, error: error instanceof Error ? error : new Error(String(error)) })
      }
    }
    return failures
  }
  async load(name: string, signal?: AbortSignal) {
    if (this.#active.has(name)) throw new PluginError('plugin_already_loaded', name)
    if (signal?.aborted) throw new PluginError('plugin_activation_cancelled', name)
    const approval = this.manager.list()[name]
    if (!approval?.enabled) throw new PluginError('plugin_not_enabled', name)
    let timer: NodeJS.Timeout | undefined
    let cancel: (() => void) | undefined
    try {
      const pluginDir = join(this.manager.root, name)
      const manifest = await this.manager.inspect(pluginDir)
      if (
        approval.version !== manifest.version ||
        approval.permissionHash !== permissionHash(manifest)
      )
        throw new PluginError('plugin_approval_stale', name)
      this.bridge.registerUiContributions(manifest)
      const dataDir = join(this.options.dataRoot, name)
      await mkdir(dataDir, { recursive: true })
      const host = await this.#start({
        entry: join(pluginDir, manifest.main),
        dataDir,
        profile: sandboxProfile(manifest, pluginDir, dataDir),
        activationTimeoutMs: this.#activationTimeoutMs,
        ...(signal ? { signal } : {}),
      })
      const connection = new PluginConnection(
        host,
        this.bridge.create(manifest, dataDir),
        this.#activationTimeoutMs,
      )
      this.#active.set(name, connection)
      if (signal?.aborted) throw new PluginError('plugin_activation_cancelled', name)
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new PluginError('plugin_activation_cancelled', name))
        signal?.addEventListener('abort', cancel, { once: true })
      })
      await Promise.race([
        connection.activated,
        cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PluginError('plugin_activation_timeout', name)),
            this.#activationTimeoutMs,
          )
        }),
      ])
    } catch (error) {
      await this.deactivate(name)
      await this.manager.recordFailure(name)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (cancel) signal?.removeEventListener('abort', cancel)
    }
  }
  async deactivate(name: string) {
    const connection = this.#active.get(name)
    if (connection) connection.dispose()
    this.#active.delete(name)
    await this.bridge.deactivate(name)
  }
  async setEnabled(name: string, enabled: boolean) {
    if (!enabled) await this.deactivate(name)
    await this.manager.setEnabled(name, enabled)
    if (enabled) await this.load(name)
  }
  async uninstall(name: string) {
    await this.deactivate(name)
    await this.manager.uninstall(name)
  }
  async dispose() {
    for (const name of this.#active.keys()) await this.deactivate(name)
  }
  active() {
    return [...this.#active.keys()]
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
export type SigningCredentialReader = (
  scope: string,
  envKeys: readonly string[],
) => Promise<Readonly<Record<string, string>>>

export interface SigningEnvironmentScope {
  dispose(): void | Promise<void>
}

export interface SigningEnvironment {
  open(environment: Readonly<Record<string, string>>): Promise<SigningEnvironmentScope>
}

export function redactSigningValues(
  value: unknown,
  environment: Readonly<Record<string, string>>,
): unknown {
  const secrets = Object.values(environment).filter(Boolean)
  const redactString = (text: string) =>
    secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactString(item)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [
          key,
          Object.hasOwn(environment, key) ? '[REDACTED]' : visit(nested),
        ]),
      )
    return item
  }
  return visit(value)
}

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
  signing?: {
    approve(manifest: PluginManifest): Promise<boolean>
    credentials: SigningCredentialReader
    environment: SigningEnvironment
  }
  transport: ProviderStreamTransport
}): ProviderDisposable {
  const { manifest, capabilities, registry, credentials, signing, transport } = options
  if (manifest.kind !== 'provider' || !manifest.provider)
    throw new PluginError('plugin_provider_invalid', 'not a provider plugin')
  const provider = manifest.provider
  const client: ProviderClient = {
    name: provider.name,
    capabilities: Object.freeze(structuredClone(capabilities)),
    async *stream(request, signal) {
      if (provider.auth.mode === 'header-template') {
        const key = await credentials(provider.auth.credentialScope)
        const authHeaders = key ? renderAuthHeaders(provider.auth.headerTemplate, key) : {}
        yield* transport.stream(provider.name, { ...request, authHeaders }, signal)
        return
      }
      if (!signing || !(await signing.approve(manifest)))
        throw new PluginError('plugin_signing_approval_required', provider.name)
      const declaredKeys = provider.auth.signing.envKeys
      const values = await signing.credentials(provider.auth.credentialScope, declaredKeys)
      const environment = Object.fromEntries(
        declaredKeys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]!]),
      )
      if (Object.keys(environment).length !== declaredKeys.length)
        throw new PluginError('plugin_signing_credentials_missing', provider.name)
      const scope = await signing.environment.open(environment)
      try {
        yield* transport.stream(provider.name, { ...request, authHeaders: {} }, signal)
      } finally {
        await scope.dispose()
      }
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

const BRIDGE_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  'tools.register': 'tools.register',
  'tools.unregister': 'tools.register',
  'hooks.on': 'hooks.on',
  'hooks.off': 'hooks.on',
  'hooks.kv.get': 'hooks.on',
  'hooks.kv.set': 'hooks.on',
  'hooks.kv.delete': 'hooks.on',
  'hooks.kv.clear': 'hooks.on',
  'commands.register': 'commands.register',
  'prompt.contribute': 'prompt.contribute',
  'prompt.revoke': 'prompt.contribute',
  'session.read': 'session.read',
  'session.on': 'session.read',
  'fs.readFile': 'fs.read',
  'fs.exists': 'fs.read',
  'fs.glob': 'fs.read',
  'fs.stat': 'fs.read',
  'fs.writeFile': 'fs.write',
  exec: 'exec',
  'http.fetch': 'http.fetch',
  'ui.confirm': 'ui.confirm',
  'ui.prompt': 'ui.prompt',
  'ui.pick': 'ui.pick',
  'ui.notify': 'ui.notify',
  'storage.get': 'storage.read',
  'storage.set': 'storage.write',
  'storage.delete': 'storage.write',
  'config.get': 'config.read',
  'log.write': 'log.write',
})

export interface BridgeSessionSnapshot {
  readonly id: string
  readonly cwd: string
  readonly messages: readonly unknown[]
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number; cost?: number }>
}
export interface BridgeHost {
  readonly session: BridgeSessionSnapshot
  register(kind: 'tool' | 'command' | 'prompt' | 'ui', value: unknown, plugin: string): Disposable
  fs: {
    readFile(path: string, encoding?: string): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    exists(path: string): Promise<boolean>
    glob(pattern: string, cwd: string): Promise<string[]>
    stat(path: string): Promise<unknown>
  }
  exec(command: string, options: unknown, signal: AbortSignal): Promise<unknown>
  fetch(url: string, init: unknown, signal: AbortSignal): Promise<unknown>
  ui(method: 'confirm' | 'prompt' | 'pick' | 'notify', params: unknown): unknown
  storage(
    plugin: string,
    operation: 'get' | 'set' | 'delete',
    key: string,
    value?: unknown,
  ): Promise<unknown>
  config(plugin: string, key: string): unknown
  log(level: string, message: string, meta?: unknown): void
}

type HookRecord = {
  plugin: string
  event: HookEvent
  handler: HookHandler
  priority: number
  order: number
}
const clone = <T>(value: T): T => structuredClone(value)
const isWithin = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const matchesHost = (host: string, rule: string) =>
  host === rule || (rule.startsWith('*.') && host.endsWith(rule.slice(1)))
const matchesCommand = (command: string, rule: string) =>
  rule.endsWith(' *')
    ? command === rule.slice(0, -2) || command.startsWith(rule.slice(0, -1))
    : command === rule
const redact = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value.replace(/(?:bearer\s+|sk-|api[_-]?key[=:]\s*)[^\s,;]+/giu, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|authorization|api.?key/i.test(key) ? '[REDACTED]' : redact(item),
      ]),
    )
  return value
}

export class BridgeRuntime {
  readonly #hooks: HookRecord[] = []
  readonly #disposables = new Map<string, Set<Disposable>>()
  readonly #kv = new Map<string, Map<string, unknown>>()
  #order = 0
  constructor(
    readonly host: BridgeHost,
    readonly options: { timeoutMs?: number; maxCallsPerTurn?: number; hookKvBytes?: number } = {},
  ) {}

  registerUiContributions(manifest: PluginManifest) {
    for (const contribution of manifest.contributes?.ui ?? []) {
      const disposable = this.host.register('ui', clone(contribution), manifest.name)
      const set = this.#disposables.get(manifest.name) ?? new Set<Disposable>()
      set.add(disposable)
      this.#disposables.set(manifest.name, set)
    }
  }

  create(manifest: PluginManifest, dataDir: string, turnId = 'activation'): ApolloBridge {
    const guard = createRpcGuard(
      {
        ...manifest,
        permissions: {
          ...manifest.permissions,
          apollo: manifest.permissions.apollo.map((method) => BRIDGE_PERMISSIONS[method] ?? method),
        },
      },
      this.options.maxCallsPerTurn ?? 500,
    )
    const check = (method: string) => guard(turnId, BRIDGE_PERMISSIONS[method] ?? method)
    const track = (disposable: Disposable) => {
      const set = this.#disposables.get(manifest.name) ?? new Set<Disposable>()
      set.add(disposable)
      this.#disposables.set(manifest.name, set)
      return disposable
    }
    const register = (kind: 'tool' | 'command' | 'prompt', value: unknown, method: string) => {
      check(method)
      return track(this.host.register(kind, value, manifest.name))
    }
    const pathFor = async (input: string, mode: 'read' | 'write') => {
      const candidate = resolve(this.host.session.cwd, input)
      const canonical = await realpath(mode === 'write' ? dirname(candidate) : candidate).then(
        (p) => (mode === 'write' ? join(p, basename(candidate)) : p),
      )
      const roots = await Promise.all(
        (manifest.permissions.fs?.[mode] ?? []).map(async (path) => {
          const root = resolve(this.host.session.cwd, path.replace(/[*?].*$/, ''))
          return realpath(root).catch(() => root)
        }),
      )
      if (!roots.some((root) => isWithin(root, canonical)))
        throw new PluginError('plugin_fs_denied', input)
      return canonical
    }
    const invoke = async <T>(
      method: string,
      task: (signal: AbortSignal) => Promise<T>,
      external?: AbortSignal,
    ) => {
      check(method)
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
      const abort = () => controller.abort()
      external?.addEventListener('abort', abort, { once: true })
      try {
        return await task(controller.signal)
      } finally {
        clearTimeout(timeout)
        external?.removeEventListener('abort', abort)
      }
    }
    const bridge: ApolloBridge = {
      apiVersion: '1.0',
      plugin: Object.freeze({ name: manifest.name, version: manifest.version, dataDir }),
      tools: {
        register: (spec) => register('tool', spec, 'tools.register'),
        unregister: () => check('tools.unregister'),
      },
      hooks: {
        on: (event, handler, options) => {
          check('hooks.on')
          const record = {
            plugin: manifest.name,
            event,
            handler,
            priority: options?.priority ?? 0,
            order: this.#order++,
          }
          this.#hooks.push(record)
          return track({ dispose: () => this.removeHook(record) })
        },
        off: (event, handler) => {
          check('hooks.off')
          for (const item of this.#hooks.filter(
            (h) => h.plugin === manifest.name && h.event === event && h.handler === handler,
          ))
            this.removeHook(item)
        },
        kv: {
          get: <T = unknown>(key: string) => {
            check('hooks.kv.get')
            return clone(this.hookKv(manifest.name, turnId).get(key)) as T | undefined
          },
          set: (key, value) => {
            check('hooks.kv.set')
            const store = this.hookKv(manifest.name, turnId)
            const next = new Map(store).set(key, clone(value))
            if (Buffer.byteLength(JSON.stringify([...next])) > (this.options.hookKvBytes ?? 65_536))
              throw new PluginError('plugin_hook_kv_quota_exceeded', key)
            store.set(key, clone(value))
          },
          delete: (key) => {
            check('hooks.kv.delete')
            this.hookKv(manifest.name, turnId).delete(key)
          },
          clear: () => {
            check('hooks.kv.clear')
            this.hookKv(manifest.name, turnId).clear()
          },
        },
      },
      commands: { register: (spec) => register('command', spec, 'commands.register') },
      prompt: {
        contribute: (fragment) => register('prompt', fragment, 'prompt.contribute'),
        revoke: () => check('prompt.revoke'),
      },
      session: {
        id: this.host.session.id,
        cwd: this.host.session.cwd,
        getMessages: (range) => {
          check('session.read')
          return clone(
            this.host.session.messages.slice(-(range?.limit ?? this.host.session.messages.length)),
          ) as never
        },
        getUsage: () => {
          check('session.read')
          return clone(this.host.session.usage)
        },
        on: () => {
          check('session.on')
          return track({ dispose() {} })
        },
      },
      fs: {
        readFile: (path, encoding) =>
          invoke('fs.readFile', async () =>
            this.host.fs.readFile(await pathFor(path, 'read'), encoding),
          ),
        writeFile: (path, data) =>
          invoke('fs.writeFile', async () =>
            this.host.fs.writeFile(await pathFor(path, 'write'), data),
          ),
        exists: (path) =>
          invoke('fs.exists', async () => this.host.fs.exists(await pathFor(path, 'read'))),
        glob: (pattern) =>
          invoke('fs.glob', async () => {
            await pathFor(pattern.replace(/[*?].*$/, '') || '.', 'read')
            return this.host.fs.glob(pattern, this.host.session.cwd)
          }),
        stat: (path) =>
          invoke('fs.stat', async () => this.host.fs.stat(await pathFor(path, 'read'))) as never,
      },
      exec: (command, options) =>
        invoke(
          'exec',
          async (signal) => {
            if (!manifest.permissions.bash?.allowlist.some((rule) => matchesCommand(command, rule)))
              throw new PluginError('plugin_exec_denied', command)
            return this.host.exec(command, clone(options), signal) as never
          },
          options?.signal,
        ) as never,
      http: {
        fetch: (url, init) =>
          invoke('http.fetch', async (signal) => {
            const parsed = new URL(url)
            if (
              parsed.protocol !== 'https:' ||
              !manifest.permissions.net ||
              !manifest.permissions.net.allowlist.some((rule) => matchesHost(parsed.hostname, rule))
            )
              throw new PluginError('plugin_net_denied', parsed.hostname)
            return this.host.fetch(url, clone(init), signal)
          }),
      },
      ui: {
        confirm: (message) => {
          check('ui.confirm')
          return this.host.ui('confirm', { message }) as Promise<boolean>
        },
        prompt: (question, options) => {
          check('ui.prompt')
          return this.host.ui('prompt', { question, options }) as Promise<string | null>
        },
        pick: (options, settings) => {
          check('ui.pick')
          return this.host.ui('pick', {
            options: clone(options),
            labels: settings ? options.map(settings.label) : undefined,
          }) as Promise<never>
        },
        notify: (message, level) => {
          check('ui.notify')
          this.host.ui('notify', { message, level })
        },
      },
      storage: {
        get: (key) => {
          check('storage.get')
          return this.host.storage(manifest.name, 'get', key) as never
        },
        set: (key, value) => {
          check('storage.set')
          return this.host.storage(manifest.name, 'set', key, clone(value)) as Promise<void>
        },
        delete: (key) => {
          check('storage.delete')
          return this.host.storage(manifest.name, 'delete', key) as Promise<void>
        },
      },
      config: {
        get: (key) => {
          check('config.get')
          if (!Object.prototype.hasOwnProperty.call(manifest.config ?? {}, key))
            throw new PluginError('plugin_config_undeclared', key)
          return clone(this.host.config(manifest.name, key)) as never
        },
      },
      log: Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map((level) => [
          level,
          (message: string, ...args: unknown[]) => {
            check('log.write')
            this.host.log(level, redact(message) as string, redact(args))
          },
        ]),
      ) as ApolloBridge['log'],
      call: async (method, _params) => {
        check(method)
        throw new PluginError('plugin_rpc_transport_only', `No direct handler for ${method}`)
      },
    }
    return Object.freeze(bridge)
  }

  async runHooks(
    event: HookEvent,
    payload: unknown,
    options: { signal?: AbortSignal; toolUseId?: string } = {},
  ): Promise<HookResult | undefined> {
    const handlers = this.#hooks
      .filter((hook) => hook.event === event)
      .sort((a, b) => b.priority - a.priority || a.order - b.order)
    for (const hook of handlers) {
      if (options.signal?.aborted) throw options.signal.reason
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new PluginError('plugin_hook_timeout', event)),
          { once: true },
        ),
      )
      try {
        const result = await Promise.race([Promise.resolve(hook.handler(clone(payload))), aborted])
        if (result?.veto) return clone(result)
      } finally {
        clearTimeout(timeout)
      }
    }
  }
  async deactivate(plugin: string) {
    for (const item of [...(this.#disposables.get(plugin) ?? [])].reverse()) await item.dispose()
    this.#disposables.delete(plugin)
    for (const hook of this.#hooks.filter((item) => item.plugin === plugin)) this.removeHook(hook)
    for (const key of [...this.#kv.keys()].filter((key) => key.startsWith(`${plugin}:`)))
      this.#kv.delete(key)
  }
  private removeHook(record: HookRecord) {
    const index = this.#hooks.indexOf(record)
    if (index >= 0) this.#hooks.splice(index, 1)
  }
  private hookKv(plugin: string, toolUseId: string) {
    const key = `${plugin}:${toolUseId}`,
      existing = this.#kv.get(key)
    if (existing) return existing
    const created = new Map<string, unknown>()
    this.#kv.set(key, created)
    return created
  }
}
