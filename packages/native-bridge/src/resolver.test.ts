import { describe, expect, it } from 'vitest'

import { packageTriple } from './resolver'

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
