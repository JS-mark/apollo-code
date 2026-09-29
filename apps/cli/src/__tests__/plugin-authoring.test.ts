import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildVolundArchive,
  extractVolundArchive,
  readZip,
  VOLUND_ARCHIVE_SUFFIX,
  writeZip,
  type ArchiveEntry,
} from '@volund/app-runtime'
import { VolundError } from '@volund/shared'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildPlugin,
  cratePlugin,
  devPlugin,
  installVolundArchive,
  type PluginAuthoringContext,
} from '../plugin-authoring'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function authoring(home: string): PluginAuthoringContext {
  return { home, version: '0.2.0' }
}

async function scaffold(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'volund-plugin-packme',
      version: '0.1.0',
      type: 'module',
      main: 'index.ts',
      engines: { volund: '^0.2.0' },
      permissions: { volund: ['log.write'] },
      ...overrides,
    }),
  )
  await writeFile(join(dir, 'index.ts'), 'export async function activate() {}\n')
  return dir
}

describe('zip container (store only)', () => {
  it('roundtrips entries byte-for-byte', () => {
    const entries: ArchiveEntry[] = [
      { name: 'manifest.json', data: new TextEncoder().encode('{"name":"x"}') },
      { name: 'index.ts', data: new Uint8Array([0, 1, 2, 255]) },
    ]
    const bytes = writeZip(entries)
    const decoded = readZip(bytes)
    expect(decoded.map((entry) => entry.name)).toEqual(['manifest.json', 'index.ts'])
    expect(Array.from(decoded[1]!.data)).toEqual([0, 1, 2, 255])
  })

  it('is deterministic: same entries, same bytes', () => {
    const entries: ArchiveEntry[] = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }]
    expect(writeZip(entries)).toEqual(writeZip(entries))
  })

  it('rejects compressed entries and corrupt containers', () => {
    const garbage = new TextEncoder().encode('not a zip')
    expect(() => readZip(garbage)).toThrowError(VolundError)
    // 篡改 central directory 条目的 method 字段（条目头 +10）为 deflate。
    const bytes = writeZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }])
    const centralStart = bytes.findIndex(
      (_, index, all) =>
        all[index] === 0x50 &&
        all[index + 1] === 0x4b &&
        all[index + 2] === 0x01 &&
        all[index + 3] === 0x02,
    )
    bytes[centralStart + 10] = 8
    expect(() => readZip(bytes)).toThrowError(/only store is supported/)
  })
})

describe('buildVolundArchive', () => {
  it('packs the directory deterministically and excludes junk', async () => {
    const dir = await scaffold(await tempDir('volund-pack-'))
    await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'junk')
    await writeFile(join(dir, '.env'), 'SECRET=1')
    await writeFile(join(dir, '.DS_Store'), 'junk')
    await writeFile(join(dir, 'volund-plugin-packme-0.1.0.volund'), 'old artifact')

    const first = await buildVolundArchive(dir)
    const second = await buildVolundArchive(dir)
    expect(first.bytes).toEqual(second.bytes)
    expect(first.manifest).toEqual({ name: 'volund-plugin-packme', version: '0.1.0' })
    expect(first.entries).toEqual(['index.ts', 'manifest.json'])
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    // 结构探针：解包端拿得到 manifest 且 main 在包里。
    const staging = await tempDir('volund-unpack-')
    const header = await extractVolundArchive(first.bytes, staging)
    expect(header.name).toBe('volund-plugin-packme')
    expect(existsSync(join(staging, 'index.ts'))).toBe(true)
  })

  it('rejects bad manifests: bad name, missing main, missing manifest', async () => {
    const badName = await scaffold(await tempDir('volund-pack-'), { name: 'not-a-volund-plugin' })
    await expect(buildVolundArchive(badName)).rejects.toMatchObject({
      name: 'VolundError',
      code: 'plugin_manifest_invalid',
    })
    const badMain = await scaffold(await tempDir('volund-pack-'), { main: 'missing.ts' })
    await expect(buildVolundArchive(badMain)).rejects.toMatchObject({
      code: 'plugin_manifest_invalid',
    })
    await expect(buildVolundArchive(await tempDir('volund-pack-'))).rejects.toMatchObject({
      code: 'plugin_manifest_invalid',
    })
  })
})

describe('extractVolundArchive zip-slip guard', () => {
  it('rejects entries escaping the target directory', async () => {
    const slip: ArchiveEntry[] = [
      {
        name: 'manifest.json',
        data: new TextEncoder().encode(
          '{"name":"volund-plugin-x","version":"0.1.0","main":"index.ts"}',
        ),
      },
      { name: '../escaped.txt', data: new TextEncoder().encode('boom') },
    ]
    const bytes = writeZip(slip)
    const staging = await tempDir('volund-slip-')
    await expect(extractVolundArchive(bytes, staging)).rejects.toMatchObject({
      code: 'plugin_archive_unsafe_entry',
    })
    expect(existsSync(join(staging, '..', 'escaped.txt'))).toBe(false)
  })
})

describe('plugin authoring actions', () => {
  it('crate scaffolds a valid plugin with host-pinned engines', async () => {
    const workspace = await tempDir('volund-crate-')
    const result = await cratePlugin(authoring(await tempDir('volund-home-')), {
      target: join(workspace, 'my-check'),
      cwd: workspace,
    })
    expect(result.name).toBe('volund-plugin-my-check')
    const manifest = JSON.parse(await readFile(join(result.dir, 'manifest.json'), 'utf8')) as {
      engines: { volund: string }
      permissions: { volund: string[] }
    }
    expect(manifest.engines.volund).toBe('^0.2.0')
    expect(manifest.permissions.volund).toContain('hooks.on')
    expect(await readFile(join(result.dir, 'index.ts'), 'utf8')).toContain(
      'export async function activate',
    )
    // 立即可打包（脚手架本身是合法插件）。
    const pack = await buildVolundArchive(result.dir)
    expect(pack.manifest.name).toBe('volund-plugin-my-check')
  })

  it('crate prefixes the volund-plugin- name and refuses non-empty targets', async () => {
    const workspace = await tempDir('volund-crate-')
    const result = await cratePlugin(authoring(await tempDir('volund-home-')), {
      target: 'my-tool',
      cwd: workspace,
    })
    expect(result.name).toBe('volund-plugin-my-tool')
    await expect(
      cratePlugin(authoring(await tempDir('volund-home-')), { target: 'my-tool', cwd: workspace }),
    ).rejects.toMatchObject({ code: 'plugin_target_exists' })
    await expect(
      cratePlugin(authoring(await tempDir('volund-home-')), { target: 'UPPER', cwd: workspace }),
    ).rejects.toMatchObject({ code: 'plugin_manifest_invalid' })
  })

  it('build writes <name>-<version>.volund and install lands it in plugins-dev', async () => {
    const home = await tempDir('volund-home-')
    const scaffolded = await cratePlugin(authoring(home), {
      target: 'ship-it',
      cwd: await tempDir('volund-crate-'),
    })
    const built = await buildPlugin(scaffolded.dir)
    expect(built.path.endsWith(`volund-plugin-ship-it-0.1.0${VOLUND_ARCHIVE_SUFFIX}`)).toBe(true)
    expect(existsSync(built.path)).toBe(true)

    const installed = await installVolundArchive(authoring(home), built.path)
    expect(installed.name).toBe('volund-plugin-ship-it')
    expect(existsSync(join(home, 'plugins-dev', 'volund-plugin-ship-it', 'manifest.json'))).toBe(
      true,
    )

    // 引擎不匹配 → 前置拒绝。
    const strict = await scaffold(await tempDir('volund-pack-'), {
      name: 'volund-plugin-strict',
      engines: { volund: '^9.0.0' },
    })
    const strictPack = await buildVolundArchive(strict)
    const strictPath = join(home, 'strict.volund')
    await writeFile(strictPath, strictPack.bytes)
    await expect(installVolundArchive(authoring(home), strictPath)).rejects.toMatchObject({
      code: 'plugin_engine_incompatible',
    })
  })

  it('dev probes the plugin and links it into the dev source directory', async () => {
    const home = await tempDir('volund-home-')
    const scaffolded = await cratePlugin(authoring(home), {
      target: 'dev-check',
      cwd: await tempDir('volund-crate-'),
    })
    const result = await devPlugin(authoring(home), scaffolded.dir)
    expect(result.manifest.name).toBe('volund-plugin-dev-check')
    expect(result.linked.mode).toBe('symlink')
    expect(existsSync(join(result.linked.dir, 'manifest.json'))).toBe(true)
    // 探测依赖本机沙箱二进制：在场则 ok 且贡献面非空；不在场则 failed 且消息透出。
    if (result.probe.status === 'ok') {
      expect(result.contributions.tools).toContain('plugin:volund-plugin-dev-check:ping')
    } else {
      expect(result.probe.error).not.toBe('')
    }
  }, 30_000)

  it('dev relinking replaces the existing dev entry', async () => {
    const home = await tempDir('volund-home-')
    const scaffolded = await cratePlugin(authoring(home), {
      target: 'relink',
      cwd: await tempDir('volund-crate-'),
    })
    const first = await devPlugin(authoring(home), scaffolded.dir)
    const second = await devPlugin(authoring(home), scaffolded.dir)
    expect(second.linked.dir).toBe(first.linked.dir)
    expect(existsSync(join(second.linked.dir, 'manifest.json'))).toBe(true)
  }, 30_000)
})
