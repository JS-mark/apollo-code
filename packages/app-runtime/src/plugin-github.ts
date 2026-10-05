/**
 * github: 插件安装通道（§6.2/§11.3.7 的 v2 首批）：`github:<owner>/<repo>[@tag]`
 * → GitHub Release 资产里的 `.volund` 包，落 `~/.volund/plugins-dev/<name>/`
 * （与 .volund 本地安装同根，新会话生效）。
 *
 * 信任模型（与 plugin-market 同纪律）：HTTPS 只保证传输完整性，不替代发布者
 * 签名——可执行插件远程安装必须走签名信任根：
 * - Release 必须携带 `<archive>.sig`（capability-contract 脱离签名信封，
 *   preimage = domainSep('volund.plugin.archive.v1', archive bytes)）；
 * - 发布者公钥由用户显式钉存（`volund plugins trust <source> --key <b64url>`，
 *   落 `~/.volund/plugins-trust.json`）；未钉源 fail closed
 *   （plugin_registry_signature_required）。
 * - `<archive>.sha256` sidecar 可选：存在即校验（mismatch 硬拒）。
 * 安装元数据写 `volund-source.json`（记录 source/tag/version），供
 * `volund plugins upgrade` 跨版本比对。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  verifyDetachedSignature,
  type DetachedSignatureEnvelope,
} from '@volund/capability-contract/authority'
import { PluginError, validateManifest } from '@volund/plugin-runtime'
import type { PluginManifest } from '@volund/plugin-sdk'

import { extractVolundArchive } from './plugin-archive'

const GITHUB_API_BASE = 'https://api.github.com'
/** 签名 role：archive 原始字节为 canonical 载荷（发布者按同一 preimage 签名）。 */
export const PLUGIN_ARCHIVE_SIGNATURE_ROLE = 'volund.plugin.archive.v1'
const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024
const GITHUB_OWNER_REPO = /^[\w.-]+$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/
/** 严格 base64url、无 padding 的 32 字节公钥（43 字符）。 */
const ED25519_PUBKEY_B64URL = /^[A-Za-z0-9_-]{43}$/

export interface GithubPluginSpec {
  readonly owner: string
  readonly repo: string
  readonly tag?: string
}

/** `github:<owner>/<repo>[@tag]` → 结构化 spec；非 github: 形态 → undefined。 */
export function parseGithubPluginSpec(spec: string): GithubPluginSpec | undefined {
  if (!spec.startsWith('github:')) return undefined
  const body = spec.slice('github:'.length)
  const [repoPath, tag] = body.split('@', 2)
  const segments = (repoPath ?? '').replace(/\.git$/, '').split('/')
  if (segments.length !== 2) return undefined
  const [owner, repo] = segments
  if (!owner || !repo || !GITHUB_OWNER_REPO.test(owner) || !GITHUB_OWNER_REPO.test(repo))
    return undefined
  if (tag !== undefined && !GITHUB_OWNER_REPO.test(tag)) return undefined
  return { owner, repo, ...(tag !== undefined ? { tag } : {}) }
}

/** 发布者标识（信任存储的键）：`github:<owner>/<repo>`（tag 不参与身份）。 */
export function githubPluginSource(spec: GithubPluginSpec): string {
  return `github:${spec.owner}/${spec.repo}`
}

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

interface GithubReleaseJson {
  tag_name?: unknown
  assets?: unknown
}

interface FetchResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

async function fetchBounded(
  url: string,
  accept: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response: FetchResponseLike = await fetch(url, {
    headers: {
      accept,
      'user-agent': 'volund-plugin-installer',
      'x-github-api-version': '2022-11-28',
    },
    ...(signal ? { signal } : {}),
  } as RequestInit & { headers: Record<string, string> })
  if (!response.ok)
    throw new PluginError('plugin_market_fetch_failed', `GET ${url} -> ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(length) && length > maxBytes)
    throw new PluginError('plugin_registry_metadata_invalid', `${url} exceeds ${maxBytes} bytes`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes)
    throw new PluginError('plugin_registry_metadata_invalid', `${url} exceeds ${maxBytes} bytes`)
  return bytes
}

function assetUrl(release: GithubReleaseJson, suffix: string): { name: string; url: string } {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const matches = assets
    .map((asset) => asset as GithubAsset)
    .filter(
      (record): record is GithubAsset & { name: string; browser_download_url: string } =>
        typeof record.name === 'string' &&
        record.name.endsWith(suffix) &&
        typeof record.browser_download_url === 'string',
    )
  if (matches.length !== 1)
    throw new PluginError(
      'plugin_registry_metadata_invalid',
      `release must carry exactly one *${suffix} asset, found ${matches.length}`,
    )
  return { name: matches[0]!.name, url: matches[0]!.browser_download_url }
}

function parseSignatureEnvelope(bytes: Uint8Array, archiveName: string): DetachedSignatureEnvelope {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new PluginError('plugin_registry_signature_invalid', `${archiveName}.sig is not JSON`)
  }
  const envelope = value as Partial<DetachedSignatureEnvelope>
  if (
    !envelope ||
    envelope.algorithm !== 'ed25519' ||
    envelope.version !== 1 ||
    typeof envelope.keyId !== 'string' ||
    typeof envelope.signatureBase64Url !== 'string' ||
    typeof envelope.signedSchemaRole !== 'string'
  )
    throw new PluginError('plugin_registry_signature_invalid', `${archiveName}.sig envelope shape`)
  return envelope as DetachedSignatureEnvelope
}

/** 发布者信任存储：`~/.volund/plugins-trust.json`（显式钉存，无自动 TOFU）。 */
export interface PluginTrustStore {
  readonly schemaVersion: 1
  readonly publishers: Readonly<Record<string, { readonly ed25519: string }>>
}

const TRUST_FILE = 'plugins-trust.json'

export async function readPluginTrustStore(home: string): Promise<PluginTrustStore> {
  let serialized: string
  try {
    serialized = await readFile(join(home, TRUST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, publishers: {} }
    throw error
  }
  const value: unknown = JSON.parse(serialized)
  if (!value || typeof value !== 'object' || (value as PluginTrustStore).schemaVersion !== 1)
    throw new PluginError('plugin_registry_metadata_invalid', `${TRUST_FILE} schemaVersion`)
  const publishers = (value as PluginTrustStore).publishers
  if (!publishers || typeof publishers !== 'object' || Array.isArray(publishers))
    throw new PluginError('plugin_registry_metadata_invalid', `${TRUST_FILE} publishers`)
  for (const [source, entry] of Object.entries(publishers)) {
    if (!entry || typeof entry.ed25519 !== 'string' || !ED25519_PUBKEY_B64URL.test(entry.ed25519))
      throw new PluginError(
        'plugin_registry_metadata_invalid',
        `${TRUST_FILE}: '${source}' ed25519 key must be 32 raw bytes base64url (43 chars)`,
      )
  }
  return { schemaVersion: 1, publishers }
}

/** 钉存发布者公钥（`volund plugins trust <source> --key <b64url>` 的落点）。 */
export async function pinPluginPublisher(
  home: string,
  source: string,
  keyBase64Url: string,
): Promise<void> {
  if (!ED25519_PUBKEY_B64URL.test(keyBase64Url))
    throw new PluginError(
      'plugin_registry_metadata_invalid',
      'ed25519 key must be 32 raw bytes base64url (43 chars, no padding)',
    )
  const store = await readPluginTrustStore(home)
  const next = { schemaVersion: 1 as const, publishers: { ...store.publishers } }
  next.publishers[source] = { ed25519: keyBase64Url }
  await mkdir(home, { recursive: true })
  await writeFile(join(home, TRUST_FILE), `${JSON.stringify(next, null, 2)}\n`)
}

export interface GithubInstallResult {
  readonly name: string
  readonly version: string
  readonly tag: string
  readonly source: string
  readonly dir: string
  readonly manifest: PluginManifest
}

/**
 * 从 GitHub Release 安装插件：签名验不出真相就拒绝——信任存储无该发布者 =
 * fail closed；签名不匹配 = 硬拒。staging 解包（zip-slip 防护）→ manifest 校验
 * → 原子换入 `~/.volund/plugins-dev/<name>/`。
 */
export async function installFromGithub(options: {
  home: string
  spec: string
  volundVersion: string
  signal?: AbortSignal
}): Promise<GithubInstallResult> {
  const { home, spec, volundVersion, signal } = options
  const parsed = parseGithubPluginSpec(spec)
  if (!parsed)
    throw new PluginError(
      'plugin_registry_source_invalid',
      `expected github:<owner>/<repo>[@tag], got '${spec}'`,
    )
  const source = githubPluginSource(parsed)
  const api =
    parsed.tag === undefined
      ? `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/releases/latest`
      : `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/releases/tags/${parsed.tag}`
  const release = JSON.parse(
    new TextDecoder().decode(
      await fetchBounded(api, 'application/vnd.github+json', MAX_RELEASE_JSON_BYTES, signal),
    ),
  ) as GithubReleaseJson
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!tag) throw new PluginError('plugin_registry_metadata_invalid', 'release tag_name missing')

  const archiveAsset = assetUrl(release, '.volund')
  const archive = await fetchBounded(
    archiveAsset.url,
    'application/octet-stream',
    MAX_ARCHIVE_BYTES,
    signal,
  )

  // sha256 sidecar（可选）：存在即校验，防御 CDN/镜像内容错位。
  const digestAssetUrl = tryAssetUrl(release, '.volund.sha256')
  if (digestAssetUrl) {
    const sidecar = new TextDecoder().decode(
      await fetchBounded(digestAssetUrl, 'text/plain', 4096, signal),
    )
    const expected = /^([a-f0-9]{64})\b/.exec(sidecar.trim())?.[1]
    const actual = createHash('sha256').update(archive).digest('hex')
    if (!expected || expected !== actual)
      throw new PluginError(
        'plugin_registry_digest_mismatch',
        `${archiveAsset.name}: expected ${expected ?? '<unparsable>'}, got ${actual}`,
      )
  }

  // 签名信任根：未钉 = fail closed；验签失败 = 硬拒。
  const store = await readPluginTrustStore(home)
  const pinned = store.publishers[source]
  if (!pinned)
    throw new PluginError(
      'plugin_registry_signature_required',
      `no trusted publisher key pinned for '${source}'; verify the key out-of-band, ` +
        `then run: volund plugins trust ${source} --key <ed25519 public key base64url>`,
    )
  const signatureAsset = (() => {
    try {
      return assetUrl(release, '.volund.sig')
    } catch {
      throw new PluginError(
        'plugin_registry_signature_required',
        `release carries no ${archiveAsset.name}.sig signature envelope; unsigned remote plugins are rejected`,
      )
    }
  })()
  const envelope = parseSignatureEnvelope(
    await fetchBounded(signatureAsset.url, 'application/json', 4096, signal),
    archiveAsset.name,
  )
  const verdict = verifyDetachedSignature({
    expectedRole: PLUGIN_ARCHIVE_SIGNATURE_ROLE,
    canonicalBytes: archive,
    envelope,
    trustedKey: { publicKeyBase64Url: pinned.ed25519 },
  })
  if (!verdict.ok)
    throw new PluginError(
      'plugin_registry_signature_invalid',
      `${archiveAsset.name}: ${verdict.reason} (role=${PLUGIN_ARCHIVE_SIGNATURE_ROLE}, key=${envelope.keyId})`,
    )

  // 落盘：staging 解包 → manifest/engines 校验 → 原子换入 plugins-dev/<name>。
  const devRoot = join(home, 'plugins-dev')
  const staging = await mkdtemp(join(tmpdir(), 'volund-plugin-github-'))
  try {
    const header = await extractVolundArchive(archive, staging)
    const manifest = validateManifest(
      JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')),
      volundVersion,
    )
    if (manifest.name !== header.name || manifest.version !== header.version)
      throw new PluginError(
        'plugin_registry_metadata_invalid',
        `archive header says ${header.name}@${header.version}, manifest says ${manifest.name}@${manifest.version}`,
      )
    const metadata = {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      source,
      tag,
      installedAt: new Date().toISOString(),
    }
    await writeFile(join(staging, 'volund-source.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const finalTarget = join(devRoot, manifest.name)
    await mkdir(devRoot, { recursive: true })
    await rm(finalTarget, { recursive: true, force: true })
    await rename(staging, finalTarget)
    return {
      name: manifest.name,
      version: manifest.version,
      tag,
      source,
      dir: finalTarget,
      manifest,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function tryAssetUrl(release: GithubReleaseJson, suffix: string): string | undefined {
  try {
    return assetUrl(release, suffix).url
  } catch {
    return undefined
  }
}

/** 从 `.volund` 资产名解析 semver（`<name>-<version>.volund`；约定无强制）。 */
export function versionFromAssetName(assetName: string): string | undefined {
  if (!assetName.endsWith('.volund')) return undefined
  const match = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/.exec(
    assetName.slice(0, -'.volund'.length),
  )
  return match?.[1]
}

/** 只探版本不下载：upgrade 比对用（版本取自 release 资产名约定）。 */
export async function resolveGithubLatestVersion(options: {
  spec: string
  signal?: AbortSignal
}): Promise<{ tag: string; version?: string }> {
  const parsed = parseGithubPluginSpec(options.spec)
  if (!parsed)
    throw new PluginError(
      'plugin_registry_source_invalid',
      `expected github:<owner>/<repo>[@tag], got '${options.spec}'`,
    )
  const api = `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/releases/latest`
  const release = JSON.parse(
    new TextDecoder().decode(
      await fetchBounded(
        api,
        'application/vnd.github+json',
        MAX_RELEASE_JSON_BYTES,
        options.signal,
      ),
    ),
  ) as GithubReleaseJson
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!tag) throw new PluginError('plugin_registry_metadata_invalid', 'release tag_name missing')
  const assets = Array.isArray(release.assets) ? release.assets : []
  const archive = assets
    .map((asset) => (asset as GithubAsset).name)
    .find((name): name is string => typeof name === 'string' && name.endsWith('.volund'))
  const version = archive !== undefined ? versionFromAssetName(archive) : undefined
  return { tag, ...(version !== undefined ? { version } : {}) }
}

/** 安装来源元数据（volund-source.json；upgrade 比对面）。 */
export interface GithubSourceMetadata {
  readonly schemaVersion: 1
  readonly name: string
  readonly version: string
  readonly source: string
  readonly tag: string
  readonly installedAt: string
}

export async function readGithubSourceMetadata(
  dir: string,
): Promise<GithubSourceMetadata | undefined> {
  let serialized: string
  try {
    serialized = await readFile(join(dir, 'volund-source.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(serialized)
  if (
    !value ||
    typeof value !== 'object' ||
    (value as GithubSourceMetadata).schemaVersion !== 1 ||
    typeof (value as GithubSourceMetadata).name !== 'string' ||
    typeof (value as GithubSourceMetadata).version !== 'string' ||
    typeof (value as GithubSourceMetadata).source !== 'string'
  )
    throw new PluginError('plugin_registry_metadata_invalid', `${dir}/volund-source.json`)
  return value as GithubSourceMetadata
}

/**
 * semver 新旧判定：release > prerelease；同状态按数值三元组比较；相等/无法
 * 解析 = 不算更新（upgrade 宁可保守）。
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const left = SEMVER.exec(candidate)
  const right = SEMVER.exec(installed)
  if (!left || !right) return false
  const [, lm, mm, pm, lpre] = left
  const [, ri, mi, pi, rpre] = right
  const tripleL = [Number(lm), Number(mm), Number(pm)]
  const tripleR = [Number(ri), Number(mi), Number(pi)]
  for (let index = 0; index < 3; index += 1) {
    if (tripleL[index] !== tripleR[index]) return tripleL[index]! > tripleR[index]!
  }
  if (lpre !== undefined && rpre === undefined) return false
  if (lpre === undefined && rpre !== undefined) return true
  return false
}
