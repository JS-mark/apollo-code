import { createHash } from 'node:crypto'

import type { MemoryRecordScope } from '@apollo-code/storage'

import type { CommandDefinition } from '../../shared/cli-types'

export const memoryCommand: CommandDefinition = {
  name: 'memory',
  async run({ args, cwd, ports }) {
    const action = args._[1]
    if (action === 'search') {
      if (!ports.memoryRecall)
        return failure('memory recall port is not connected', Boolean(args.json), 2, 'unavailable')
      const query = args._.slice(2).join(' ').trim()
      if (!query)
        return failure('memory search requires a query', Boolean(args.json), 2, 'invalid_usage')
      try {
        const scope = commandScope(args.scope, args.sessionId, cwd)
        const hits = await ports.memoryRecall.recall(scope, query, {
          limit: integerOption(args.limit, 10, 'limit'),
          tags: stringList(args.tag),
        })
        const result = { query, scope, hits }
        return {
          exitCode: 0,
          stdout: args.json
            ? `${JSON.stringify(result)}\n`
            : hits.length
              ? `${hits
                  .map(
                    ({ record, score }) =>
                      `${record.id}\t${score.toFixed(3)}\t${oneLine(record.content)}`,
                  )
                  .join('\n')}\n`
              : 'No matching memories.\n',
          stderr: '',
        }
      } catch (error) {
        return failure(error, Boolean(args.json))
      }
    }
    if (action === 'doctor') {
      if (!ports.memoryMaintenance)
        return failure(
          'memory maintenance port is not connected',
          Boolean(args.json),
          2,
          'unavailable',
        )
      const report = await ports.memoryMaintenance.doctor()
      return {
        exitCode: args.strict && !report.healthy ? 1 : 0,
        stdout: args.json
          ? `${JSON.stringify(report)}\n`
          : `${report.facts.healthy ? '✓' : '✗'} facts: ${report.facts.detail} (${report.facts.records} records)\n${report.index.healthy ? '✓' : '✗'} index: ${report.index.detail} (${report.index.indexedRecords} records)\n`,
        stderr: '',
      }
    }
    if (action === 'reindex') {
      if (!ports.memoryMaintenance)
        return failure(
          'memory maintenance port is not connected',
          Boolean(args.json),
          2,
          'unavailable',
        )
      try {
        const report = await ports.memoryMaintenance.reindex({
          batchSize: integerOption(args.batchSize, 250, 'batch-size'),
          check: Boolean(args.check),
          force: Boolean(args.force),
        })
        return {
          exitCode: args.check && !report.after.healthy ? 1 : 0,
          stdout: args.json
            ? `${JSON.stringify(report)}\n`
            : `${report.action}: ${report.after.status}; processed ${report.processedRecords} records in ${report.durationMs}ms\n`,
          stderr: '',
        }
      } catch (error) {
        return failure(error, Boolean(args.json))
      }
    }
    return failure(
      'Usage: apollo memory <search|doctor|reindex>',
      Boolean(args.json),
      2,
      'invalid_usage',
    )
  },
}

function commandScope(scope: unknown, sessionId: unknown, cwd: string): MemoryRecordScope {
  if (scope !== undefined && typeof scope !== 'string')
    throw new TypeError('--scope must be a string')
  const kind = scope ?? 'project'
  const workspaceId = 'local'
  if (kind === 'workspace') return { kind, workspaceId }
  const projectId = createHash('sha256').update(cwd).digest('hex').slice(0, 32)
  if (kind === 'project') return { kind, workspaceId, projectId }
  if (kind === 'session' && typeof sessionId === 'string' && sessionId)
    return { kind, workspaceId, projectId, sessionId }
  throw new TypeError(
    kind === 'session'
      ? '--scope session requires --session-id'
      : '--scope must be workspace, project, or session',
  )
}

function integerOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new TypeError(`--${name} must be an integer`)
  return parsed
}

function stringList(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function oneLine(value: string): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
}

function failure(error: unknown, json: boolean, exitCode = 1, fallbackCode = 'memory_error') {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : fallbackCode
  return json
    ? {
        exitCode,
        stdout: `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
        stderr: '',
      }
    : { exitCode, stdout: '', stderr: message }
}
