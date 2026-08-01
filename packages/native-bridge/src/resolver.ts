import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
export type BinaryKind = 'sandbox' | 'search' | 'fs'

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

export async function resolveBinary(kind: BinaryKind): Promise<string | null> {
  const override = process.env[`APOLLO_NATIVE_${kind.toUpperCase()}_BINARY`]
  if (override) {
    await access(override)
    return override
  }
  const triple = packageTriple(process.platform, process.arch, runtimeLibc())
  if (!triple) return null
  try {
    const manifest = require.resolve(`@apollo-code/native-${kind}-${triple}/package.json`)
    const metadata = require(manifest) as { bin?: Record<string, string> }
    const relative = metadata.bin?.[`apollo-${kind}`]
    return relative ? join(dirname(manifest), relative) : null
  } catch {
    return null
  }
}
