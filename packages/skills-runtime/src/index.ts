import { access, copyFile, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { Disposable, PromptComposer } from '@apollo-code/core'
import { parse } from 'yaml'

export interface SkillMetadata {
  name: string
  description: string
  apolloVersion: string
  version?: string
  activation?: { manual?: boolean; auto?: Array<{ path_exists?: string; secret?: string }> }
  resources: string[]
  path: string
}
export interface SkillsRuntimeOptions {
  skillsDir: string
  apolloVersion: string
  composer: PromptComposer
  loadMarkdown?: (path: string) => Promise<string>
  onWarning?: (message: string) => void
}

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new TypeError('SKILL.md requires YAML frontmatter')
  const data = parse(match[1]!)
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new TypeError('Invalid frontmatter')
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) }
}
function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Skill ${key} is required`)
  return value.trim()
}
function compatible(range: string, version: string): boolean {
  const wanted = /^(?:\^|~)?(\d+)/.exec(range)?.[1]
  const actual = /^(\d+)/.exec(version)?.[1]
  return wanted !== undefined && wanted === actual
}
async function readText(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new TypeError(`${path} is not a file`)
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

export class SkillsRuntime {
  readonly #skills = new Map<string, SkillMetadata>()
  readonly #active = new Map<string, Disposable>()
  #index?: Disposable
  constructor(readonly options: SkillsRuntimeOptions) {}
  async discover(): Promise<SkillMetadata[]> {
    this.#skills.clear()
    let entries
    try {
      entries = await readdir(this.options.skillsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const path = resolve(this.options.skillsDir, entry.name, 'SKILL.md')
      try {
        const text = await readText(path)
        const { data } = frontmatter(text)
        const resources = data.resources
        const skill: SkillMetadata = {
          name: requiredString(data, 'name'),
          description: requiredString(data, 'description'),
          apolloVersion: requiredString(data, 'apolloVersion'),
          resources: Array.isArray(resources)
            ? resources.filter((item): item is string => typeof item === 'string')
            : [],
          path,
        }
        if (typeof data.version === 'string') skill.version = data.version
        if (data.activation && typeof data.activation === 'object')
          skill.activation = data.activation as NonNullable<SkillMetadata['activation']>
        if (this.#skills.has(skill.name)) throw new TypeError(`Duplicate skill name: ${skill.name}`)
        this.#skills.set(skill.name, skill)
        if (!compatible(skill.apolloVersion, this.options.apolloVersion))
          this.options.onWarning?.(
            `Skill ${skill.name} requires Apollo ${skill.apolloVersion}; running ${this.options.apolloVersion}`,
          )
      } catch (error) {
        this.options.onWarning?.(
          `Failed to discover ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return [...this.#skills.values()]
  }
  async installFromDirectory(sourceDir: string): Promise<SkillMetadata> {
    const sourcePath = resolve(sourceDir, 'SKILL.md')
    const { data } = frontmatter(await readText(sourcePath))
    const name = requiredString(data, 'name')
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`Invalid skill name: ${name}`)
    const resources = Array.isArray(data.resources)
      ? data.resources.filter((item): item is string => typeof item === 'string')
      : []
    const sourceRoot = await realpath(sourceDir)
    const targetRoot = resolve(this.options.skillsDir, name)
    try {
      await mkdir(targetRoot, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(this.options.skillsDir, { recursive: true })
        await mkdir(targetRoot, { recursive: false })
      } else if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new TypeError(`Skill already installed: ${name}`, { cause: error })
      } else throw error
    }
    try {
      await copyFile(sourcePath, resolve(targetRoot, 'SKILL.md'))
      for (const resource of resources) {
        if (isAbsolute(resource))
          throw new TypeError(`Skill resource must be relative: ${resource}`)
        const source = await realpath(resolve(sourceRoot, resource))
        const rel = relative(sourceRoot, source)
        if (rel.startsWith('..') || isAbsolute(rel))
          throw new TypeError(`Skill resource escapes skill directory: ${resource}`)
        const target = resolve(targetRoot, rel)
        await mkdir(resolve(target, '..'), { recursive: true })
        await copyFile(source, target)
      }
    } catch (error) {
      await rm(targetRoot, { recursive: true, force: true })
      throw error
    }
    const installed = (await this.discover()).find((skill) => skill.name === name)
    if (!installed) throw new TypeError(`Installed skill could not be discovered: ${name}`)
    await this.registerIndex()
    return installed
  }
  async registerIndex(): Promise<void> {
    this.#index?.dispose()
    this.#index = this.options.composer.register({
      id: 'skills:index',
      source: 'skills:index',
      priority: 850,
      when: () => this.#skills.size > 0,
      text: () =>
        this.#skills.size === 0
          ? ''
          : `Available skills (activate via /skill activate <name>):\n${[...this.#skills.values()]
              .map((skill) => `- ${skill.name}: ${skill.description}`)
              .join('\n')}`,
    })
  }
  async activate(name: string): Promise<boolean> {
    if (this.#active.has(name)) return false
    const skill = this.#skills.get(name)
    if (!skill) throw new TypeError(`Unknown skill: ${name}`)
    const root = await realpath(resolve(skill.path, '..'))
    const load = this.options.loadMarkdown ?? readText
    const raw = await load(skill.path)
    const { body } = frontmatter(raw)
    const resources: string[] = []
    for (const resource of skill.resources) {
      if (isAbsolute(resource)) throw new TypeError(`Skill resource must be relative: ${resource}`)
      const target = await realpath(resolve(root, resource))
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel))
        throw new TypeError(`Skill resource escapes skill directory: ${resource}`)
      resources.push(`<!-- skill resource: ${resource} -->\n${await load(target)}`)
    }
    this.#active.set(
      name,
      this.options.composer.register({
        id: `skill:${name}`,
        source: `skill:${name}`,
        priority: 800,
        text: [body.trim(), ...resources].filter(Boolean).join('\n\n'),
      }),
    )
    return true
  }
  async activateAutomatic(cwd: string, userText = ''): Promise<string[]> {
    const activated: string[] = []
    for (const skill of this.#skills.values()) {
      const rules = skill.activation?.auto ?? []
      if (rules.length === 0) continue
      const matches = await Promise.all(
        rules.map(async (rule) => {
          if (rule.path_exists) {
            try {
              await access(resolve(cwd, rule.path_exists))
              return true
            } catch {
              return false
            }
          }
          return rule.secret
            ? userText.toLocaleLowerCase().includes(rule.secret.toLocaleLowerCase())
            : false
        }),
      )
      if (matches.some(Boolean) && (await this.activate(skill.name))) activated.push(skill.name)
    }
    return activated
  }
  deactivate(name: string): boolean {
    const active = this.#active.get(name)
    if (!active) return false
    active.dispose()
    this.#active.delete(name)
    return true
  }
  active(): string[] {
    return [...this.#active.keys()].toSorted()
  }
  dispose(): void {
    this.#index?.dispose()
    for (const item of this.#active.values()) item.dispose()
    this.#active.clear()
  }
}
