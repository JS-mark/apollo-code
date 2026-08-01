import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { JsonValue } from '@apollo-code/shared'
export type Config = Record<string, JsonValue>
export type TrustDecision = 'allow-project' | 'allow-once' | 'deny'
export interface ConfigLayerOptions {
  defaults: Config
  global?: Config
  project?: Config
  env?: Config
  flags?: Config
  interactive?: boolean
  trustProjectConfig?: boolean
  previousProjectHash?: string
  promptTrust?: (input: { hash: string; keys: string[] }) => Promise<TrustDecision>
  warning?: (key: string) => void
}
const forbidden = (key: string) =>
  /^provider\..*\.baseurl$/i.test(key) ||
  /^telemetry\.(?:sink|otel\.endpoint)$/i.test(key) ||
  /^router(?:\.|$)/i.test(key) ||
  /^auth(?:\.|$)/i.test(key) ||
  /_api_key$/i.test(key)
function flatten(
  input: Config,
  prefix = '',
  out: Record<string, JsonValue> = {},
): Record<string, JsonValue> {
  for (const [k, v] of Object.entries(input)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}
function assign(out: Config, key: string, value: JsonValue) {
  const parts = key.split('.')
  let cursor = out
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    cursor = next && typeof next === 'object' && !Array.isArray(next) ? next : (cursor[part] = {})
  }
  cursor[parts.at(-1)!] = value
}
function merge(
  out: Config,
  layer?: Config,
  project = false,
  warning?: (key: string) => void,
): Config {
  for (const [k, v] of Object.entries(flatten(layer ?? {}))) {
    if (project && forbidden(k)) {
      warning?.(k)
      continue
    }
    assign(out, k, v)
  }
  return out
}
export async function loadConfig(
  options: ConfigLayerOptions,
): Promise<{ config: Config; projectHash: string | undefined; trusted: boolean }> {
  const out = merge({}, options.defaults)
  merge(out, options.global)
  let trusted = false,
    hash: string | undefined
  if (options.project) {
    hash = createHash('sha256')
      .update(JSON.stringify(flatten(options.project)))
      .digest('hex')
    if (options.trustProjectConfig) trusted = true
    else if (options.interactive === false) trusted = false
    else if (hash === options.previousProjectHash) trusted = true
    else
      trusted =
        (await options.promptTrust?.({ hash, keys: Object.keys(flatten(options.project)) })) !==
        'deny'
    if (trusted) merge(out, options.project, true, options.warning)
  }
  merge(out, options.env)
  merge(out, options.flags)
  return { config: out, projectHash: hash, trusted }
}
export async function parseTomlFile(path: string): Promise<Config> {
  const text = await readFile(path, 'utf8'),
    out: Config = {},
    section: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) {
      section.splice(0, section.length, ...header[1]!.split('.'))
      continue
    }
    const pair = /^([\w.-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) throw new Error(`Invalid TOML line: ${raw}`)
    let value: JsonValue
    try {
      value = JSON.parse(pair[2]!)
    } catch {
      throw new Error(`Unsupported TOML value: ${pair[2]}`)
    }
    assign(out, [...section, pair[1]!].join('.'), value)
  }
  return out
}
