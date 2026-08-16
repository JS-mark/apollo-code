import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { tempApolloHome } from './temp-apollo-home'

const originalHome = process.env.HOME
const originalApolloHome = process.env.APOLLO_HOME
let capturedHome: string | undefined

describe('tempApolloHome', () => {
  it('creates an isolated HOME with a prefilled .apollo directory', async () => {
    const fixture = await tempApolloHome()
    try {
      expect(fixture.home.startsWith(join(tmpdir()))).toBe(true)
      expect(process.env.HOME).toBe(fixture.home)
      expect(process.env.APOLLO_HOME).toBe(fixture.apolloDir)
      expect(fixture.apolloDir).toBe(join(fixture.home, '.apollo'))
      expect(fixture.configPath).toBe(join(fixture.apolloDir, 'config.toml'))
      expect(fixture.credentialsPath).toBe(join(fixture.apolloDir, 'credentials.enc'))
      expect((await stat(fixture.apolloDir)).isDirectory()).toBe(true)
      expect(existsSync(fixture.configPath)).toBe(false)
      expect(existsSync(fixture.credentialsPath)).toBe(false)
    } finally {
      await fixture.restore()
    }
  })

  it('restores the original environment and deletes the directory on restore', async () => {
    const fixture = await tempApolloHome()
    expect(process.env.HOME).toBe(fixture.home)
    await fixture.restore()
    expect(process.env.HOME).toBe(originalHome)
    expect(process.env.APOLLO_HOME).toBe(originalApolloHome)
    expect(existsSync(fixture.home)).toBe(false)
  })

  it('restore is idempotent', async () => {
    const fixture = await tempApolloHome()
    await fixture.restore()
    await expect(fixture.restore()).resolves.toBeUndefined()
    expect(process.env.HOME).toBe(originalHome)
  })

  it('serializes a config object to config.toml', async () => {
    const fixture = await tempApolloHome({
      config: { memory: { enabled: true, budget: 512 }, theme: 'dark', tags: ['a', 'b'] },
    })
    try {
      const content = await readFile(fixture.configPath, 'utf8')
      expect(content).toContain('theme = "dark"')
      expect(content).toContain('tags = ["a", "b"]')
      expect(content).toContain('[memory]')
      expect(content).toContain('enabled = true')
      expect(content).toContain('budget = 512')
    } finally {
      await fixture.restore()
    }
  })

  it('writes a raw config string verbatim', async () => {
    const fixture = await tempApolloHome({ config: '[memory]\nenabled = true\n' })
    try {
      expect(await readFile(fixture.configPath, 'utf8')).toBe('[memory]\nenabled = true\n')
    } finally {
      await fixture.restore()
    }
  })

  it('prefills credentials.enc with the provided content', async () => {
    const fixture = await tempApolloHome({ credentials: 'fake' })
    try {
      expect(await readFile(fixture.credentialsPath, 'utf8')).toBe('fake')
    } finally {
      await fixture.restore()
    }
  })

  it('creates extra files under .apollo including nested directories', async () => {
    const fixture = await tempApolloHome({
      files: { 'memory/records.json': '[]', 'sessions/s1/session.jsonl': '{"v":1}\n' },
    })
    try {
      expect(await readFile(join(fixture.apolloDir, 'memory', 'records.json'), 'utf8')).toBe('[]')
      expect(
        await readFile(join(fixture.apolloDir, 'sessions', 's1', 'session.jsonl'), 'utf8'),
      ).toBe('{"v":1}\n')
    } finally {
      await fixture.restore()
    }
  })

  it('rejects file paths that escape the .apollo directory', async () => {
    await expect(tempApolloHome({ files: { '../escape.txt': 'x' } })).rejects.toThrow(
      'testkit_path_escape: ../escape.txt',
    )
  })

  it('overrides a pre-existing APOLLO_HOME during the test and restores it', async () => {
    const previous = process.env.APOLLO_HOME
    process.env.APOLLO_HOME = '/tmp/apollo-testkit-leak-guard'
    const fixture = await tempApolloHome()
    try {
      expect(process.env.APOLLO_HOME).toBe(fixture.apolloDir)
    } finally {
      await fixture.restore()
      expect(process.env.APOLLO_HOME).toBe('/tmp/apollo-testkit-leak-guard')
      process.env.APOLLO_HOME = previous
    }
  })

  it('restores an unset APOLLO_HOME to unset', async () => {
    const previous = process.env.APOLLO_HOME
    delete process.env.APOLLO_HOME
    const fixture = await tempApolloHome()
    try {
      expect(process.env.APOLLO_HOME).toBe(fixture.apolloDir)
    } finally {
      await fixture.restore()
      expect(process.env.APOLLO_HOME).toBeUndefined()
      if (previous !== undefined) process.env.APOLLO_HOME = previous
    }
  })

  it('registers automatic teardown with the running vitest test', async () => {
    const fixture = await tempApolloHome()
    capturedHome = fixture.home
    expect(process.env.HOME).toBe(fixture.home)
  })

  it('has already restored the environment torn down by the previous test', () => {
    expect(capturedHome).toBeDefined()
    expect(process.env.HOME).toBe(originalHome)
    expect(existsSync(capturedHome ?? '/nonexistent')).toBe(false)
  })
})
