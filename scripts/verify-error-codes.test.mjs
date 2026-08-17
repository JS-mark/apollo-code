import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  auditErrorCodes,
  extractEmittedCodes,
  isErrorCodeLiteral,
  parseAppendixCodes,
  parseRegistry,
} from './verify-error-codes.mjs'

void test('isErrorCodeLiteral accepts snake_case and UPPER_SNAKE with at least two segments', () => {
  assert.equal(isErrorCodeLiteral('tool_loop_exhausted'), true)
  assert.equal(isErrorCodeLiteral('APOLLO_UNSAFE_CWD'), true)
  assert.equal(isErrorCodeLiteral('single'), false)
  assert.equal(isErrorCodeLiteral('has space'), false)
  assert.equal(isErrorCodeLiteral('camelCase'), false)
  assert.equal(isErrorCodeLiteral(''), false)
})

void test('parseRegistry reads entries with and without trailing comments', () => {
  const filler = Array.from(
    { length: 8 },
    (_, index) => `  filler${index}: 'filler_code_${index}',`,
  )
  const source = [
    "import type { JsonValue } from './index'",
    '',
    'export const ErrorCodes = {',
    "  toolLoopExhausted: 'tool_loop_exhausted',",
    "  runnerError: 'runner_error', // runner.ts 顶层 catch",
    ...filler,
    '} as const',
    '',
    "export const appendixErrorCodes = ['tool_loop_exhausted'] as const",
  ].join('\n')
  const { entries, errors } = parseRegistry(source)
  assert.deepEqual(errors, [])
  assert.deepEqual(entries.slice(0, 2), [
    { key: 'toolLoopExhausted', code: 'tool_loop_exhausted' },
    { key: 'runnerError', code: 'runner_error' },
  ])
  assert.equal(entries.length, 10)
})

void test('parseRegistry reports structural failures instead of guessing', () => {
  assert.match(parseRegistry('export const Other = {}').errors.join('\n'), /missing/)
  assert.match(parseRegistry('export const ErrorCodes = {').errors.join('\n'), /as const/)
  assert.match(
    parseRegistry('export const ErrorCodes = {\n  only: "one",\n} as const').errors.join('\n'),
    /fewer than 10/,
  )
})

void test('parseAppendixCodes extracts only the B.2 table and skips adjacent B.3 rows', () => {
  const markdown = [
    '## B.2 登记表',
    '',
    '| code | 来源章节 |',
    '|---|---|',
    '| `tool_loop_exhausted` | §2.4 B2 |',
    '| `stream_interrupted` | §2.4 B6 |',
    '',
    '## B.3 相邻登记（非 error.raised，但同属跨模块契约）',
    '',
    '| 标识 | 类型 |',
    '|---|---|',
    '| `ipc.line_too_large` | telemetry 事件 |',
    '| exit code `4` | CLI exit code |',
  ].join('\n')
  assert.deepEqual(parseAppendixCodes(markdown), ['tool_loop_exhausted', 'stream_interrupted'])
  assert.deepEqual(parseAppendixCodes('# no appendix here'), [])
})

void test('extractEmittedCodes covers every emit idiom and skips prose messages', () => {
  const files = [
    {
      path: 'packages/core/src/runner.ts',
      source: [
        "await this.emit('error.raised', turnId, { code: 'tool_loop_exhausted' })",
        "code: typeof error.code === 'string' ? error.code : 'internal_error',",
      ].join('\n'),
    },
    {
      path: 'packages/router/src/index.ts',
      source: [
        "throw new Error('fallback_chain_empty')",
        'throw new Error(`provider_not_registered: ${name}`)',
        "throw new Error('theme_invalid: expected an object')",
        "throw new Error('sandbox binary disappeared; restart required')",
      ].join('\n'),
    },
    {
      path: 'packages/plugin-runtime/src/index.ts',
      source:
        "throw new PluginError(\n  'plugin_manifest_invalid',\n  'manifest must be an object',\n)",
    },
  ]
  assert.deepEqual(
    extractEmittedCodes(files).map((emit) => emit.code),
    [
      'tool_loop_exhausted',
      'internal_error',
      'fallback_chain_empty',
      'provider_not_registered',
      'theme_invalid',
      'plugin_manifest_invalid',
    ],
  )
})

void test('auditErrorCodes fails on unregistered emits, appendix gaps, and zombie entries', () => {
  const registryEntries = [
    { key: 'registered', code: 'registered_code' },
    { key: 'specOnly', code: 'spec_only_code' },
  ]
  const emitted = [{ path: 'src/a.ts', code: 'registered_code' }]
  const exempt = new Map([['spec_only_code', '附录 B.2 预留']])

  assert.deepEqual(auditErrorCodes({ registryEntries, appendixCodes: [], emitted, exempt }), [])

  const drift = auditErrorCodes({
    registryEntries,
    appendixCodes: ['missing_from_registry'],
    emitted: [
      ...emitted,
      { path: 'src/b.ts', code: 'brand_new_unregistered' },
      { path: 'src/b.ts', code: 'registered_code' },
    ],
    exempt,
  })
  assert.match(drift.join('\n'), /missing_from_registry.*missing from/)
  assert.match(drift.join('\n'), /src\/b\.ts: emitted code 'brand_new_unregistered'/)

  const zombie = auditErrorCodes({
    registryEntries: [...registryEntries, { key: 'zombie', code: 'zombie_code' }],
    appendixCodes: [],
    emitted,
    exempt,
  })
  assert.match(zombie.join('\n'), /'zombie_code' \(zombie\) is never emitted and not exempt/)

  const staleExempt = auditErrorCodes({
    registryEntries,
    appendixCodes: [],
    emitted,
    exempt: new Map([
      ['spec_only_code', 'ok'],
      ['not_in_registry', 'stale'],
    ]),
  })
  assert.match(staleExempt.join('\n'), /exemption 'not_in_registry' is not in the registry/)

  const duplicates = auditErrorCodes({
    registryEntries: [
      { key: 'a', code: 'same_code' },
      { key: 'b', code: 'same_code' },
    ],
    appendixCodes: [],
    emitted: [{ path: 'src/a.ts', code: 'same_code' }],
    exempt: new Map(),
  })
  assert.match(duplicates.join('\n'), /duplicate code 'same_code'/)
})
