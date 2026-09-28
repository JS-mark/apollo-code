/**
 * `volund plugins crate|dev|build|install` —— 插件创作工具链（.volund 打包面）。
 *
 * - crate：脚手架（manifest.json + index.ts + README），engines 钉当前宿主版本。
 * - dev：就地探测（manifest 校验 + 真实沙箱激活一次）+ 软链进
 *   `~/.volund/plugins-dev/<name>/`（新会话自动装载；dev 源约定见 plugins-domain）。
 * - build：确定性 .volund（store zip、sha256 稳定），输出 `<name>-<version>.volund`。
 * - install：解包 .volund 落 `~/.volund/plugins-dev/<name>/`（engines 不满足即拒）。
 *
 * 与 `volund plugin`（单数，legacy 目录管理）不同：本族全部面向沙箱插件链路。
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import {
  buildVolundArchive,
  extractVolundArchive,
  readPluginManifestHeader,
  VOLUND_ARCHIVE_SUFFIX,
} from '@volund/app-runtime'
import { activateLocalPlugin, satisfies } from '@volund/plugin-runtime'
import { VolundError } from '@volund/shared'

export interface PluginAuthoringContext {
  /** 用户级 volund home（dev/install 落 `plugins-dev/`）。 */
  readonly home: string
  /** 当前 CLI 版本（engines 钉版与 satisfies 校验基准）。 */
  readonly version: string
}

const PLUGIN_NAME_PREFIX = 'volund-plugin-'
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function pluginNameFrom(target: string): string {
  const slug = basename(target)
  if (slug.startsWith(PLUGIN_NAME_PREFIX)) {
    const rest = slug.slice(PLUGIN_NAME_PREFIX.length)
    if (PLUGIN_NAME_PATTERN.test(rest)) return slug
    throw new VolundError('plugin_manifest_invalid', `invalid plugin name '${slug}'`)
  }
  if (!PLUGIN_NAME_PATTERN.test(slug))
    throw new VolundError(
      'plugin_manifest_invalid',
      `plugin name must be kebab-case ([a-z0-9_-]), got '${slug}'`,
    )
  return `${PLUGIN_NAME_PREFIX}${slug}`
}

function crateFiles(
  name: string,
  hostVersion: string,
): {
  manifest: string
  entry: string
  readme: string
} {
  return {
    manifest: `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        type: 'module',
        main: 'index.ts',
        engines: { volund: `^${hostVersion}` },
        permissions: {
          volund: ['tools.register', 'hooks.on', 'log.write'],
        },
      },
      null,
      2,
    )}\n`,
    entry: `/**
 * ${name} —— volund 插件脚手架。
 *
 * 入口契约：export async function activate(volund: VolundBridge)。
 * 沙箱内可用面：tools.register / hooks.on / commands.register / storage /
 * http.fetch（manifest net allowlist 把门）/ log。可运行参考实现见仓库
 * examples/plugins/（volund-plugin-task-notify 是任务终态 webhook 通知）。
 *
 * dev：  volund plugins dev <本目录>   —— 探测 + 软链进 ~/.volund/plugins-dev/
 * build：volund plugins build <本目录> —— 产出 dist .volund 包
 */
import type { VolundBridge } from '@volund/plugin-sdk'

export async function activate(volund: VolundBridge) {
  await volund.tools.register({
    name: 'ping',
    description: 'Return a fixed greeting (starter tool)',
    handler: async () => ({ text: 'pong' }),
  })

  volund.hooks.on('task.completed', (payload) => {
    void volund.log.info('task completed', { payload })
  })

  await volund.log.info('${name} activated')
}
`,
    readme: `# ${name}

volund 插件脚手架（\`volund plugins crate\` 生成）。

- dev：\`volund plugins dev .\` —— 探测装载并软链进 \`~/.volund/plugins-dev/\`
- build：\`volund plugins build .\` —— 产出 \`.volund\` 包（sha256 随构建打印）
- 权限：在 \`manifest.json\` 的 \`permissions\` 里按需追加；\`net.allowlist\` 把出网域
- 事件订阅名单见 plugin-sdk 的 HookEvent；任务终态通知参考 examples/plugins/volund-plugin-task-notify
`,
  }
}

export interface CrateResult {
  readonly dir: string
  readonly name: string
  readonly files: readonly string[]
}

export async function cratePlugin(
  ctx: PluginAuthoringContext,
  options: { target: string; cwd: string },
): Promise<CrateResult> {
  const name = pluginNameFrom(options.target)
  const dir = isAbsolute(options.target)
    ? resolve(options.target)
    : resolve(options.cwd, options.target)
  if (existsSync(dir)) {
    const existing = await readdir(dir).catch(() => [] as string[])
    if (existing.length > 0)
      throw new VolundError(
        'plugin_target_exists',
        `target directory ${dir} already exists and is not empty`,
      )
  }
  const files = crateFiles(name, ctx.version)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), files.manifest)
  await writeFile(join(dir, 'index.ts'), files.entry)
  await writeFile(join(dir, 'README.md'), files.readme)
  return { dir, name, files: ['manifest.json', 'index.ts', 'README.md'] }
}

export interface DevProbeContribution {
  readonly tools: readonly string[]
  readonly commands: readonly string[]
  readonly hooks: readonly string[]
  readonly prompts: readonly string[]
}

export interface DevResult {
  readonly manifest: { readonly name: string; readonly version: string }
  readonly contributions: DevProbeContribution
  /** 'ok' = 真实沙箱激活通过；failed = 探测异常（消息原样透出，软链仍会建立）。 */
  readonly probe: { readonly status: 'ok' } | { readonly status: 'failed'; readonly error: string }
  readonly linked: { readonly dir: string; readonly mode: 'symlink' | 'copy' }
}

export async function devPlugin(ctx: PluginAuthoringContext, dir: string): Promise<DevResult> {
  const root = resolve(dir)
  const header = await readPluginManifestHeader(root)

  const dataDirRoot = await mkdtemp(join(tmpdir(), 'volund-plugin-dev-'))
  let contributions: DevProbeContribution
  let probe: DevResult['probe']
  try {
    const activated = await activateLocalPlugin({
      dir: root,
      volundVersion: ctx.version,
      dataDirRoot,
      services: {},
    })
    contributions = {
      tools: activated.tools.map((tool) => tool.name),
      commands: activated.commands.map((command) => command.name),
      hooks: activated.hooks.map((hook) => hook.event),
      prompts: activated.prompts.map((prompt) => prompt.id),
    }
    await activated.deactivate()
    probe = { status: 'ok' }
  } catch (error) {
    contributions = { tools: [], commands: [], hooks: [], prompts: [] }
    probe = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await rm(dataDirRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  const devRoot = join(ctx.home, 'plugins-dev')
  await mkdir(devRoot, { recursive: true })
  const entry = join(devRoot, header.name)
  await rm(entry, { recursive: true, force: true }).catch(() => undefined)
  let mode: DevResult['linked']['mode'] = 'symlink'
  try {
    await symlink(root, entry)
  } catch {
    await cp(root, entry, { recursive: true })
    mode = 'copy'
  }
  return {
    manifest: { name: header.name, version: header.version },
    contributions,
    probe,
    linked: { dir: entry, mode },
  }
}

export interface BuildResult {
  readonly path: string
  readonly sha256: string
  readonly entries: readonly string[]
  readonly size: number
  readonly manifest: { readonly name: string; readonly version: string }
}

export async function buildPlugin(dir: string, outPath?: string): Promise<BuildResult> {
  const pack = await buildVolundArchive(dir)
  const path = outPath
    ? resolve(outPath)
    : join(resolve(dir), `${pack.manifest.name}-${pack.manifest.version}${VOLUND_ARCHIVE_SUFFIX}`)
  await writeFile(path, pack.bytes)
  return {
    path,
    sha256: pack.sha256,
    entries: pack.entries,
    size: pack.bytes.length,
    manifest: pack.manifest,
  }
}

export interface InstallResult {
  readonly name: string
  readonly version: string
  readonly dir: string
}

export async function installVolundArchive(
  ctx: PluginAuthoringContext,
  archivePath: string,
): Promise<InstallResult> {
  const bytes = new Uint8Array(await readFile(archivePath))
  const staging = await mkdtemp(join(tmpdir(), 'volund-plugin-install-'))
  try {
    const header = await extractVolundArchive(bytes, staging)
    // engines 与当前宿主不匹配即拒（激活期还会再验一次，这里前置给出可读错误）。
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as {
      engines?: { volund?: string }
    }
    const range = manifest.engines?.volund
    if (range && !satisfies(ctx.version, range))
      throw new VolundError(
        'plugin_engine_incompatible',
        `plugin requires volund ${range}, but this CLI is ${ctx.version}`,
      )
    const target = join(ctx.home, 'plugins-dev', header.name)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await cp(staging, target, { recursive: true })
    return { name: header.name, version: header.version, dir: target }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}
