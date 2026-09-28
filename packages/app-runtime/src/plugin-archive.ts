/**
 * `.volund` 插件包（vsce/VSIX 同型：zip 容器、manifest.json 在根）。
 *
 * 写入端只产 store（无压缩）条目 + 固定 DOS 时间戳 → 同一目录重复构建得到
 * 字节级一致的产物（sha256 稳定，可与市场 digest 校验同语）。读取端只解
 * store 条目（deflate 拒绝），条目名做 zip-slip 检查。插件包都是小文件，
 * 不做 >64k 条目 / >4GB 的 zip64 路径。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { VolundError } from '@volund/shared'

export const VOLUND_ARCHIVE_SUFFIX = '.volund'

/** 插件名规则（plugins-domain LEGACY_PLUGIN_NAME 同型）：volund-plugin- 前缀 + 受限字符。 */
const PLUGIN_NAME_PATTERN = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/

function assertPluginName(name: string): void {
  if (!PLUGIN_NAME_PATTERN.test(name))
    throw new VolundError(
      'plugin_manifest_invalid',
      `manifest name '${name}' does not match ${PLUGIN_NAME_PATTERN}`,
    )
}

/** 打包排除：依赖/版本库/密钥面/历史产物一律不进包。 */
const EXCLUDED_FILES = new Set(['.DS_Store', 'volund-market.json'])
const EXCLUDED_DIRS = new Set(['node_modules', '.git'])
const EXCLUDED_PATTERNS: readonly RegExp[] = [/^\.env($|\.)/, /\.volund$/]

export interface ArchiveEntry {
  readonly name: string
  readonly data: Uint8Array
}

/* ── zip 容器（store only）────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index++)
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** store-only zip（时间戳恒 0、条目按传入顺序；调用方先排好序保确定性）。 */
export function writeZip(entries: readonly ArchiveEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + nameBytes.length + entry.data.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(8, 0, true) // method = store
    view.setUint32(14, crc, true)
    view.setUint32(18, entry.data.length, true)
    view.setUint32(22, entry.data.length, true)
    view.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(entry.data, 30 + nameBytes.length)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + 22)
  let cursor = 0
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

/** 只解 store 条目；zip64/压缩条目/损坏目录一律 plugin_archive_invalid 族拒绝。 */
export function readZip(bytes: Uint8Array): readonly ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    throw new VolundError(
      'plugin_archive_invalid',
      'not a zip container (end-of-central-directory missing)',
    )
  const count = view.getUint16(eocd + 10, true)
  const decoder = new TextDecoder()
  let cursor = view.getUint32(eocd + 16, true)
  const entries: ArchiveEntry[] = []
  for (let index = 0; index < count; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50)
      throw new VolundError('plugin_archive_invalid', `corrupt central directory at entry ${index}`)
    const method = view.getUint16(cursor + 10, true)
    const size = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (method !== 0)
      throw new VolundError(
        'plugin_archive_unsupported_method',
        `entry '${name}' uses compression method ${method}; only store is supported`,
      )
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    entries.push({ name, data: bytes.slice(dataStart, dataStart + size) })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function assertSafeEntryName(name: string): void {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
    throw new VolundError(
      'plugin_archive_unsafe_entry',
      `archive entry '${name}' escapes the target directory`,
    )
}

/* ── .volund 打包 / 解包 ──────────────────────────────────────────────────── */

export interface VolundPackResult {
  readonly bytes: Uint8Array
  readonly entries: readonly string[]
  readonly sha256: string
  readonly manifest: { readonly name: string; readonly version: string }
}

function excluded(relativeName: string): boolean {
  const segments = relativeName.split('/')
  const base = segments[segments.length - 1] ?? ''
  if (EXCLUDED_FILES.has(base) || EXCLUDED_DIRS.has(base)) return true
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(base))
}

async function collectFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue
        await walk(path)
        continue
      }
      const name = relative(root, path).split(sep).join('/')
      if (!excluded(name)) files.push(name)
    }
  }
  await walk(root)
  return files.sort()
}

export interface VolundManifestHeader {
  readonly name: string
  readonly version: string
  readonly main: string
}

/** 读并校验 manifest 骨架（name/main/engines/version），缺失即 plugin_manifest_invalid。 */
export async function readManifestHeader(dir: string): Promise<VolundManifestHeader> {
  const root = resolve(dir)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new VolundError(
      'plugin_manifest_invalid',
      `manifest.json is missing or not valid JSON in ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const name = typeof raw['name'] === 'string' ? raw['name'] : ''
  const version = typeof raw['version'] === 'string' ? raw['version'] : ''
  const main = typeof raw['main'] === 'string' ? raw['main'] : ''
  assertPluginName(name)
  if (!/^\d+\.\d+\.\d+/.test(version))
    throw new VolundError(
      'plugin_manifest_invalid',
      `manifest version must be x.y.z, got '${version}'`,
    )
  if (!main || main.startsWith('/') || main.includes('..'))
    throw new VolundError(
      'plugin_manifest_invalid',
      `manifest main must be a relative file, got '${main}'`,
    )
  if (!existsSync(join(root, main)))
    throw new VolundError(
      'plugin_manifest_invalid',
      `manifest main '${main}' does not exist in ${root}`,
    )
  return { name, version, main }
}

/** 目录 → 确定性 .volund 字节（manifest 校验 + 排除面 + 排序 + store zip）。 */
export async function buildVolundArchive(dir: string): Promise<VolundPackResult> {
  const root = resolve(dir)
  const header = await readManifestHeader(root)
  const names = await collectFiles(root)
  const entries: ArchiveEntry[] = []
  for (const name of names)
    entries.push({ name, data: new Uint8Array(await readFile(join(root, name))) })
  const bytes = writeZip(entries)
  return {
    bytes,
    entries: names,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifest: { name: header.name, version: header.version },
  }
}

/** .volund 字节 → 目标目录（zip-slip 防护 + manifest 在根校验）。返回 manifest 头。 */
export async function extractVolundArchive(
  bytes: Uint8Array,
  targetDir: string,
): Promise<VolundManifestHeader> {
  const entries = readZip(bytes)
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry)
    throw new VolundError('plugin_archive_invalid', 'manifest.json missing at archive root')
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Record<
    string,
    unknown
  >
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : ''
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : ''
  const main = typeof manifest['main'] === 'string' ? manifest['main'] : ''
  assertPluginName(name)
  await mkdir(targetDir, { recursive: true })
  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    const path = resolve(targetDir, entry.name)
    if (!path.startsWith(resolve(targetDir) + sep))
      throw new VolundError(
        'plugin_archive_unsafe_entry',
        `archive entry '${entry.name}' escapes the target directory`,
      )
    await mkdir(resolve(path, '..'), { recursive: true })
    await writeFile(path, entry.data)
  }
  if (!existsSync(join(targetDir, main)))
    throw new VolundError('plugin_archive_invalid', `manifest main '${main}' missing from archive`)
  return { name, version, main }
}
