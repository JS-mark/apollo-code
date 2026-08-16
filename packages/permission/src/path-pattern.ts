import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import picomatch from 'picomatch'

/**
 * Permission `fs.read` / `fs.write` 路径模式匹配 —— 方言钉死（spec §4.4「路径模式语义」，r13-I2）：
 *
 * 1. 实现库 = **picomatch**（与 fast-glob 同源），全仓唯一 glob 方言；
 *    Glob 工具的 pattern 翻译后续也从这里走（tools 侧待接线）。
 * 2. `**` 跨目录分隔符（`globstar: true`）；**大小写敏感**（`nocase: false`，宁可多弹窗不少拦）。
 * 3. 匹配前双方 canonicalize 到绝对路径并展开 `~`；被检路径再走 `realpath`
 *    （防 symlink 绕过白名单）。模式侧**故意不做** realpath：允许一个 symlink 路径
 *    不应静默放行其目标树。注意：在 macOS 上模式应按真实路径书写
 *    （如 `/private/tmp/...` 而非 `/tmp/...`），否则被检路径 realpath 后无法命中。
 * 4. 相对模式（`./…`、`../…`）相对 `cwd` 解析；**无前导锚点的裸名模式不支持**（防误配过宽）。
 * 5. 否定模式 `!` 不支持 —— deny 走 `permissions.toml` 黑名单（决策链 1-2），不混入 PermissionSpec。
 */
export interface PathPatternOptions {
  /** 相对模式 / 相对被检路径的解析基准；缺省 process.cwd()。 */
  readonly cwd?: string
}

/** 不受支持的权限路径模式（裸名 / 否定 / `~user`）。 */
export class PathPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathPatternError'
  }
}

const MATCHER_OPTIONS = {
  // 规则 2：** 跨目录分隔符；大小写敏感
  globstar: true,
  nocase: false,
  // 保守方向：`*` / `**` 不进入点开头的目录段，除非模式显式写出（如 `/.hidden/**`）
  dot: false,
} as const

const matcherCache = new Map<string, picomatch.Matcher>()

function matcherFor(pattern: string): picomatch.Matcher {
  let matcher = matcherCache.get(pattern)
  if (!matcher) {
    matcher = picomatch(pattern, MATCHER_OPTIONS)
    matcherCache.set(pattern, matcher)
  }
  return matcher
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (path.startsWith('~'))
    throw new PathPatternError(`home expansion is only supported for "~" and "~/": ${path}`)
  return path
}

/** 规则 4 + 5：模式必须带锚点（`/`、`~/`、`./`、`../`），且不允许否定。 */
function assertSupportedPattern(pattern: string): void {
  if (pattern.startsWith('!'))
    throw new PathPatternError(
      `negation patterns are not supported; deny rules belong in permissions.toml: ${pattern}`,
    )
  const anchored =
    isAbsolute(pattern) ||
    pattern === '~' ||
    pattern.startsWith('~/') ||
    pattern === '.' ||
    pattern === '..' ||
    pattern.startsWith('./') ||
    pattern.startsWith('../')
  if (!anchored)
    throw new PathPatternError(
      `bare-name patterns are not supported; anchor with "/", "~/" or "./": ${pattern}`,
    )
}

/** realpath 尽力而为：目标不存在（如尚未创建的写目标）时，回退到最近存在的祖先的 realpath。 */
function realpathBestEffort(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path // 已到文件系统根
    return join(realpathBestEffort(parent), basename(path))
  }
}

/** 模式侧 canonicalize：锚点校验 + `~` 展开 + resolve 绝对化（保持词法形态，不做 realpath）。 */
export function canonicalizePattern(pattern: string, options: PathPatternOptions = {}): string {
  assertSupportedPattern(pattern)
  return resolve(options.cwd ?? process.cwd(), expandHome(pattern))
}

/** 被检路径侧 canonicalize：`~` 展开 + resolve 绝对化 + best-effort realpath（规则 3）。 */
export function canonicalizePath(path: string, options: PathPatternOptions = {}): string {
  return realpathBestEffort(resolve(options.cwd ?? process.cwd(), expandHome(path)))
}

/** 按钉死的方言判断被检路径是否命中权限模式。非法模式抛 {@link PathPatternError}。 */
export function matchPath(pattern: string, path: string, options: PathPatternOptions = {}): boolean {
  return matcherFor(canonicalizePattern(pattern, options))(canonicalizePath(path, options))
}
