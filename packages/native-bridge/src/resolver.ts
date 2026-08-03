import { createHash } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const packageVersion = (require('../package.json') as { version: string }).version
export type BinaryKind = 'sandbox' | 'search' | 'fs'

const releaseRepository = 'JS-mark/apollo-code'

export function packageTriple(
  platform: NodeJS.Platform,
  runtimeArch: string,
  libc?: 'glibc' | 'musl',
): string | null {
  const arch = runtimeArch === 'arm64' ? 'arm64' : runtimeArch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'linux') return `linux-${arch}-${libc === 'musl' ? 'musl' : 'gnu'}`
  if (platform === 'win32') return `win32-${arch}-msvc`
  return null
}

function runtimeLibc(): 'glibc' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined
  const report = process.report.getReport()
  if (!('header' in report) || typeof report.header !== 'object' || report.header === null)
    return 'musl'
  return 'glibcVersionRuntime' in report.header ? 'glibc' : 'musl'
}

export function releaseAssetName(kind: BinaryKind, triple: string): string {
  return `apollo-${kind}-${triple}${triple.startsWith('win32-') ? '.exe' : ''}`
}

function checksumFor(manifest: string, assetName: string): string | null {
  for (const line of manifest.split('\n')) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match?.[2] === assetName) return match[1] ?? null
  }
  return null
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function fetchReleaseBinary(kind: BinaryKind, triple: string): Promise<string | null> {
  const version = process.env.APOLLO_VERSION ?? packageVersion
  if (!version || version === '0.0.0') return null

  const tag = version.startsWith('v') ? version : `v${version}`
  const assetName = releaseAssetName(kind, triple)
  const releaseBase =
    process.env.APOLLO_NATIVE_RELEASE_BASE_URL ??
    `https://github.com/${releaseRepository}/releases/download/${tag}`
  const cacheRoot =
    process.env.APOLLO_NATIVE_CACHE_DIR ?? join(homedir(), '.cache', 'apollo-code', 'native')
  const targetDirectory = join(cacheRoot, tag, triple)
  const binaryPath = join(targetDirectory, assetName)
  const checksumPath = join(cacheRoot, tag, 'checksums.sha256')
  const checksumUrl = `${releaseBase}/checksums.sha256`

  await mkdir(targetDirectory, { recursive: true })
  try {
    const cachedExpected = checksumFor(await readFile(checksumPath, 'utf8'), assetName)
    if (cachedExpected && (await sha256(binaryPath)) === cachedExpected) return binaryPath
  } catch {
    // A cache miss is expected on first use.
  }

  let checksumResponse: Response
  try {
    checksumResponse = await fetch(checksumUrl)
  } catch {
    return null
  }
  if (!checksumResponse.ok) return null
  const checksumManifest = await checksumResponse.text()
  const expected = checksumFor(checksumManifest, assetName)
  if (!expected) return null
  await writeFile(checksumPath, checksumManifest)

  try {
    if ((await sha256(binaryPath)) === expected) return binaryPath
    await rm(binaryPath, { force: true })
  } catch {
    // A cache miss is expected on first use.
  }

  let binaryResponse: Response
  try {
    binaryResponse = await fetch(`${releaseBase}/${assetName}`)
  } catch {
    return null
  }
  if (!binaryResponse.ok) return null
  const temporaryPath = `${binaryPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, Buffer.from(await binaryResponse.arrayBuffer()), { mode: 0o755 })
    if ((await sha256(temporaryPath)) !== expected)
      throw new Error(`Checksum mismatch for native asset ${assetName}`)
    await chmod(temporaryPath, 0o755)
    await rename(temporaryPath, binaryPath)
    return binaryPath
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function resolveBinary(kind: BinaryKind): Promise<string | null> {
  const override = process.env[`APOLLO_NATIVE_${kind.toUpperCase()}_BINARY`]
  if (override) {
    await access(override)
    return override
  }
  const triple = packageTriple(process.platform, process.arch, runtimeLibc())
  if (!triple) return null
  return fetchReleaseBinary(kind, triple)
}
