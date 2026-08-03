import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { packageTriple, releaseAssetName, resolveBinary } from './resolver'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  vi.unstubAllGlobals()
})

describe('packageTriple', () => {
  it.each([
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['linux', 'x64', 'glibc', 'linux-x64-gnu'],
    ['linux', 'arm64', 'musl', 'linux-arm64-musl'],
    ['win32', 'x64', undefined, 'win32-x64-msvc'],
    ['win32', 'arm64', undefined, 'win32-arm64-msvc'],
  ] as const)('maps %s/%s/%s', (platform, arch, libc, expected) => {
    expect(packageTriple(platform, arch, libc)).toBe(expected)
  })

  it('rejects unsupported targets', () => {
    expect(packageTriple('freebsd', 'x64')).toBeNull()
    expect(packageTriple('linux', 'ia32', 'glibc')).toBeNull()
  })
})

describe('Release asset resolution', () => {
  it('uses stable target-specific asset names', () => {
    expect(releaseAssetName('fs', 'darwin-arm64')).toBe('apollo-fs-darwin-arm64')
    expect(releaseAssetName('search', 'win32-x64-msvc')).toBe('apollo-search-win32-x64-msvc.exe')
  })

  it('downloads, verifies, and reuses a cached versioned binary', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'apollo-native-'))
    const body = Buffer.from('verified native binary')
    const digest = createHash('sha256').update(body).digest('hex')
    const asset = releaseAssetName('fs', packageTriple(process.platform, process.arch)!)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(`${digest}  ${asset}\n`))
      .mockResolvedValueOnce(new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    process.env.APOLLO_VERSION = '1.2.3'
    process.env.APOLLO_NATIVE_CACHE_DIR = cache
    process.env.APOLLO_NATIVE_RELEASE_BASE_URL = 'https://release.invalid/v1.2.3'

    try {
      const first = await resolveBinary('fs')
      expect(first).not.toBeNull()
      expect(await readFile(first!)).toEqual(body)
      expect(await resolveBinary('fs')).toBe(first)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  it('rejects an asset whose checksum does not match', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'apollo-native-'))
    const asset = releaseAssetName('search', packageTriple(process.platform, process.arch)!)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(`${'0'.repeat(64)}  ${asset}\n`))
        .mockResolvedValueOnce(new Response('tampered')),
    )
    process.env.APOLLO_VERSION = '1.2.3'
    process.env.APOLLO_NATIVE_CACHE_DIR = cache
    process.env.APOLLO_NATIVE_RELEASE_BASE_URL = 'https://release.invalid/v1.2.3'

    try {
      await expect(resolveBinary('search')).rejects.toThrow('Checksum mismatch')
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })
})
