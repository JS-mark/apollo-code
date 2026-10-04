/**
 * MCP tool 上线信任门 S2（§11.3.9 / 2026-09-30 design §S3）：工具集快照存储。
 * `~/.volund/mcp-tool-trust.json` 记每 server 最近一次批准的工具集 hash——连接期
 * 比对：首次或变更 → 逐调用 fail-closed（`mcp_tool_unapproved`），批准后放行。
 * 文件损坏按「无快照」处理（首次信任门语义），绝不因存储问题放行未批准工具。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { McpToolDescription } from '@volund/mcp-client'

export interface McpToolTrustStore {
  /** 同步查快照（无缓存命中时返回 undefined——调用方应先用 approvedHashAsync 预热）。 */
  approvedHash(server: string): string | undefined
  /** 异步查快照（连接期比对用）。 */
  approvedHashAsync(server: string): Promise<string | undefined>
  approve(server: string, toolsHash: string): Promise<void>
  /** 移除快照（server 被 remove / 重新 add 时调用——变更必须重新走信任门）。 */
  remove(server: string): Promise<void>
}

const SCHEMA_VERSION = 1

interface TrustDocument {
  schemaVersion: number
  servers: Record<string, { toolsHash: string; approvedAt: string }>
}

/**
 * 工具集指纹：name+description+inputSchema+permissionSpec 的 canonical JSON
 * （按 name 排序）取 sha256。permissionSpec 是纯数据对象（tool-kit 契约）。
 */
export function mcpToolsHash(tools: readonly McpToolDescription[]): string {
  const canonical = JSON.stringify(
    [...tools]
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
        permissionSpec: tool.permissionSpec ?? {},
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  )
  return createHash('sha256').update(canonical).digest('hex')
}

export function createMcpToolTrustStore(home: string): McpToolTrustStore {
  const filePath = join(home, 'mcp-tool-trust.json')
  /** 同步快照缓存：approvedHashAsync 装载后驻内存，invoke 门零 IO。 */
  let cache: Map<string, string> | undefined
  const read = async (): Promise<TrustDocument> => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as TrustDocument
      if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.servers !== 'object')
        return { schemaVersion: SCHEMA_VERSION, servers: {} }
      return parsed
    } catch {
      return { schemaVersion: SCHEMA_VERSION, servers: {} }
    }
  }
  const write = async (document: TrustDocument): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  }
  return {
    approvedHash(server) {
      return cache?.get(server)
    },
    async approvedHashAsync(server: string): Promise<string | undefined> {
      const document = await read()
      cache = new Map(
        Object.entries(document.servers).map(([name, entry]) => [name, entry.toolsHash]),
      )
      const hash = document.servers[server]?.toolsHash
      return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined
    },
    async approve(server, toolsHash) {
      const document = await read()
      document.servers[server] = { toolsHash, approvedAt: new Date().toISOString() }
      await write(document)
      cache?.set(server, toolsHash)
    },
    async remove(server) {
      const document = await read()
      if (document.servers[server] === undefined) return
      delete document.servers[server]
      await write(document)
      cache?.delete(server)
    },
  }
}
