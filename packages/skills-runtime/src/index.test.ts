import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { DefaultPromptComposer } from '@apollo-code/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillsRuntime } from './index'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'apollo-skills-'))
  dirs.push(root)
  const skill = resolve(root, 'skills', 'testing')
  await mkdir(resolve(skill, 'references'), { recursive: true })
  await writeFile(
    resolve(skill, 'SKILL.md'),
    `---\nname: testing\ndescription: Test projects safely\napolloVersion: ^1.0.0\nversion: 1.2.0\nactivation:\n  manual: true\nresources:\n  - references/details.md\n---\n# Testing\nRun focused tests.`,
  )
  await writeFile(resolve(skill, 'references/details.md'), 'Never skip failures.')
  return { root, skill }
}

describe('SkillsRuntime', () => {
  it('installs only a skill manifest and its declared resources', async () => {
    const { root, skill } = await fixture()
    const installRoot = resolve(root, 'installed')
    const runtime = new SkillsRuntime({
      skillsDir: installRoot,
      apolloVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
    })
    expect((await runtime.installFromDirectory(skill)).name).toBe('testing')
    expect(await runtime.discover()).toHaveLength(1)
    await expect(runtime.installFromDirectory(skill)).rejects.toThrow('already installed')
  })
  it('discovers only metadata, then progressively loads declared resources on activation', async () => {
    const { root } = await fixture()
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      apolloVersion: '1.0.0',
      composer,
    })
    expect(await runtime.discover()).toEqual([
      expect.objectContaining({ name: 'testing', description: 'Test projects safely' }),
    ])
    await runtime.registerIndex()
    let prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).toContain('testing: Test projects safely')
    expect(prompt).not.toContain('Run focused tests')
    expect(await runtime.activate('testing')).toBe(true)
    expect(await runtime.activate('testing')).toBe(false)
    prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).toContain('Run focused tests')
    expect(prompt).toContain('Never skip failures')
    expect(runtime.deactivate('testing')).toBe(true)
    expect(await composer.compose({ cwd: root, model: 'm', provider: 'p' })).not.toContain(
      'Run focused tests',
    )
  })

  it('warns on incompatible versions and rejects undeclared or escaping resources', async () => {
    const { root, skill } = await fixture()
    await writeFile(resolve(root, 'secret.md'), 'secret')
    await writeFile(
      resolve(skill, 'SKILL.md'),
      `---\nname: testing\ndescription: Test projects safely\napolloVersion: ^2.0.0\nresources:\n  - ../../secret.md\n---\nBody`,
    )
    const warning = vi.fn()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      apolloVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
      onWarning: warning,
    })
    await runtime.discover()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('requires Apollo'))
    await expect(runtime.activate('testing')).rejects.toThrow('escapes skill directory')
  })
})
