import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  appendixRowIds,
  auditConfigDocs,
  implementationOnlyKeys,
  parseAppendixRows,
  parseKeyRegistry,
} from './verify-config-docs.mjs'

void test('parseKeyRegistry reads entries and skips comments between rows', () => {
  const filler = Array.from({ length: 19 }, (_, index) => `  'filler${index}.key': 'allowed',`)
  const source = [
    "import { z } from 'zod'",
    '',
    'export const configKeyRegistry = {',
    "  'tools.windows_shell': 'allowed',",
    "  'telemetry.sink': 'forbidden', // §8.3.1 数据流向门",
    ...filler,
    '} as const satisfies Record<string, ProjectOverride>',
  ].join('\n')
  const { entries, errors } = parseKeyRegistry(source)
  assert.deepEqual(errors, [])
  assert.deepEqual(entries.slice(0, 2), [
    { key: 'tools.windows_shell', override: 'allowed' },
    { key: 'telemetry.sink', override: 'forbidden' },
  ])
  assert.equal(entries.length, 21)
})

void test('parseKeyRegistry reports structural failures instead of guessing', () => {
  assert.match(parseKeyRegistry('export const Other = {}').errors.join('\n'), /missing/)
  assert.match(parseKeyRegistry('export const configKeyRegistry = {').errors.join('\n'), /as const/)
  assert.match(
    parseKeyRegistry("export const configKeyRegistry = {\n  only: 'one',\n} as const").errors.join(
      '\n',
    ),
    /fewer than 20/,
  )
})

void test('parseAppendixRows extracts C.2 rows with escaped pipes and skips adjacent sections', () => {
  const filler = Array.from(
    { length: 13 },
    (_, index) => `| \`[memory]\` | \`filler_${index}\` | int | §6.12 | allowed |`,
  )
  const markdown = [
    '## C.1 未知 key 策略',
    '',
    '| 规则 |',
    '|---|',
    '| 未知 key → warn |',
    '',
    '## C.2 全量表',
    '',
    '| Section | Key | 类型 / 默认 | 来源 | projectOverride |',
    '|---|---|---|---|---|',
    '| `[provider]` | `default` | string，必填 | §8.3 | allowed |',
    '| `[router]` | `type` | `"single" \\| "fallback" \\| "role"` | §3.7 | **forbidden**（§8.3.1） |',
    '| `[tools]` | `windows_shell` | string?（r13-I11） | §4.3.1 | allowed |',
    '| `[tools]` | `pass_through_env` | string[]，默认 `[]`（r13-I11） | §4.3.1 | allowed |',
    '| `[models.aliases]` | `<alias>` | `{ provider, model }` | §3.9 | allowed |',
    '| `[auth]` | （全部） | — | §8.4 | **forbidden**（§8.3.1） |',
    '| `[evolution]` | enable / namespace 参数护栏 | 见 §15 | §15 | allowed |',
    ...filler,
    '',
    '## C.3 全量示例',
    '',
    '| `[provider]` | 后续示例段（不应被解析） | x | x | allowed |',
  ].join('\n')
  const { rows, errors } = parseAppendixRows(markdown)
  assert.deepEqual(errors, [])
  assert.deepEqual(rows.slice(0, 7), [
    { section: 'provider', key: '`default`', override: 'allowed' },
    { section: 'router', key: '`type`', override: 'forbidden' },
    { section: 'tools', key: '`windows_shell`', override: 'allowed' },
    { section: 'tools', key: '`pass_through_env`', override: 'allowed' },
    { section: 'models.aliases', key: '`<alias>`', override: 'allowed' },
    { section: 'auth', key: '（全部）', override: 'forbidden' },
    { section: 'evolution', key: 'enable / namespace 参数护栏', override: 'allowed' },
  ])
  assert.equal(rows.length, 7 + filler.length)
  assert.match(parseAppendixRows('# no appendix here').errors.join('\n'), /missing/)
})

void test('appendixRowIds normalizes tokens, wildcards, and open-section rows', () => {
  assert.deepEqual(appendixRowIds({ section: 'provider.<name>', key: '`baseUrl` / `endpoint`' }), [
    'provider.*.baseUrl',
    'provider.*.endpoint',
  ])
  assert.deepEqual(appendixRowIds({ section: 'models.aliases', key: '`<alias>`' }), [
    'models.aliases.*',
  ])
  assert.deepEqual(appendixRowIds({ section: 'memory', key: '`paths.global` / `paths.project`' }), [
    'memory.paths.global',
    'memory.paths.project',
  ])
  // 含「等」的开放段行 → 段通配；无反引号 token 的行（见 §5.5 / §15）同样
  assert.deepEqual(
    appendixRowIds({ section: 'context', key: '`keep` / `unkeep` 等 pinned 参数' }),
    ['context.*'],
  )
  assert.deepEqual(appendixRowIds({ section: 'sandbox', key: '降级策略 / tier 相关' }), [
    'sandbox.*',
  ])
  assert.deepEqual(appendixRowIds({ section: 'auth', key: '（全部）' }), ['auth.*'])
  assert.deepEqual(appendixRowIds({ section: 'prompt', key: '`@include` 参数（max_depth 32）' }), [
    'prompt.@include',
  ])
})

void test('auditConfigDocs passes when registry and appendix C.2 agree', () => {
  const registryEntries = [
    { key: 'tools.windows_shell', override: 'allowed' },
    { key: 'telemetry.sink', override: 'forbidden' },
  ]
  const appendixRows = [
    { section: 'tools', key: '`windows_shell`', override: 'allowed' },
    { section: 'telemetry', key: '`sink`', override: 'forbidden' },
  ]
  assert.deepEqual(auditConfigDocs({ registryEntries, appendixRows, exempt: new Map() }), [])
})

void test('auditConfigDocs fails on drift in either direction and on override mismatch', () => {
  const registryEntries = [
    { key: 'tools.windows_shell', override: 'allowed' },
    { key: 'ui.theme', override: 'allowed' },
    { key: 'ui.color', override: 'allowed' },
  ]
  const appendixRows = [
    { section: 'tools', key: '`windows_shell`', override: 'forbidden' },
    { section: 'ui', key: '`theme`', override: 'allowed' },
    { section: 'router', key: '`type`', override: 'forbidden' },
  ]
  const drift = auditConfigDocs({ registryEntries, appendixRows, exempt: new Map() })
  assert.match(drift.join('\n'), /'tools\.windows_shell' is 'forbidden' but .* says 'allowed'/)
  assert.match(drift.join('\n'), /appendix C\.2 key 'router\.type' is missing from/)
  assert.match(drift.join('\n'), /'ui\.color' is not documented in appendix C\.2/)

  const exempted = auditConfigDocs({
    registryEntries,
    appendixRows: [
      { section: 'tools', key: '`windows_shell`', override: 'allowed' },
      { section: 'ui', key: '`theme`', override: 'allowed' },
    ],
    exempt: new Map([['ui.color', '实现内建段，附录 C 补录中']]),
  })
  assert.deepEqual(exempted, [])

  const staleExempt = auditConfigDocs({
    registryEntries,
    appendixRows: [
      { section: 'tools', key: '`windows_shell`', override: 'allowed' },
      { section: 'ui', key: '`theme`', override: 'allowed' },
      { section: 'ui', key: '`color`', override: 'allowed' },
    ],
    exempt: new Map([
      ['ui.color', '实现内建段，附录 C 补录中'],
      ['not.in.registry', 'stale'],
    ]),
  })
  assert.match(staleExempt.join('\n'), /exemption 'not.in.registry' is not in the registry/)

  const duplicates = auditConfigDocs({
    registryEntries: [
      { key: 'ui.color', override: 'allowed' },
      { key: 'ui.color', override: 'allowed' },
    ],
    appendixRows: [{ section: 'ui', key: '`color`', override: 'allowed' }],
    exempt: new Map(),
  })
  assert.match(duplicates.join('\n'), /duplicate key 'ui\.color'/)
})

void test('implementationOnlyKeys only exempts keys that exist in the registry', () => {
  // 自检：豁免表当前只含 preferences.*，且其来源说明必须非空（防"免登记"漂移）。
  for (const [id, reason] of implementationOnlyKeys) {
    assert.match(id, /\.\*$/)
    assert.ok(reason.length > 0, `exemption '${id}' must document a real source`)
  }
})

test('wildcard registry entries cover same-section appendix rows in both directions', () => {
  const errors = auditConfigDocs({
    registryEntries: [{ key: 'preferences.*', override: 'allowed' }],
    appendixRows: [
      { section: 'preferences', key: '`outputStyle`', override: 'allowed' },
      { section: 'preferences', key: '`language`', override: 'allowed' },
    ],
    exempt: new Map(),
  })
  assert.deepEqual(errors, [])
})
