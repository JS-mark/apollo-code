/**
 * net 权限匹配粒度 = origin（spec §4.4「net 匹配粒度 = origin」，r13-D1）：
 * `net` 权限 key 按 `scheme://host[:port]` 归一 —— 同域不同路径 / 查询串共享 allow-session；
 * `WebFetch` 首次弹窗按 origin 记忆。
 *
 * 实现基于 WHATWG URL 解析：scheme / host 小写化，特殊 scheme（http/https/ws/wss/ftp）的
 * 默认端口被剥除（`https://a:443` ≡ `https://a`）；非特殊 scheme（如 `git://`，其
 * `URL.origin` 为 `"null"`）显式保留 host[:port]。userinfo 不进入 origin。
 */
export class InvalidNetUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidNetUrlError'
  }
}

/** 将 URL 归一为 `scheme://host[:port]`；无 host 或不可解析时抛 {@link InvalidNetUrlError}。 */
export function normalizeOrigin(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new InvalidNetUrlError(`invalid net URL: ${url}`)
  }
  if (!parsed.hostname) throw new InvalidNetUrlError(`net URL has no host: ${url}`)
  const port = parsed.port // 特殊 scheme 的默认端口已被 URL 剥除
  return `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ''}`
}
