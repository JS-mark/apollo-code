import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
export type BinaryKind = 'sandbox' | 'search' | 'fs'

function packageTriple(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'linux') return `linux-${arch}-gnu`
  return null
}

export async function resolveBinary(kind: BinaryKind): Promise<string | null> {
  const override = process.env[`APOLLO_NATIVE_${kind.toUpperCase()}_BINARY`]
  if (override) { await access(override); return override }
  const triple = packageTriple()
  if (!triple) return null
  try {
    const manifest = require.resolve(`@apollo-code/native-${kind}-${triple}/package.json`)
    const metadata = require(manifest) as { bin?: Record<string, string> }
    const relative = metadata.bin?.[`apollo-${kind}`]
    return relative ? join(dirname(manifest), relative) : null
  } catch { return null }
}
