import assert from 'node:assert/strict'
import { test } from 'node:test'

import { relativeSpecifierError, outDirError } from './verify-typescript-config.mjs'

test('accepts a .ts specifier when it maps to TypeScript source', () => {
  assert.equal(
    relativeSpecifierError(
      '/repo/src/cli.ts',
      './ports.ts',
      (path) => path === '/repo/src/ports.ts',
    ),
    undefined,
  )
})

test('rejects emitted extensions, extensionless specifiers, and missing targets', () => {
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './ports.js'), /emitted extension/)
  assert.match(
    relativeSpecifierError('/repo/src/cli.ts', './ports'),
    /no supported TypeScript source extension/,
  )
  assert.match(
    relativeSpecifierError('/repo/src/cli.ts', './missing.ts', () => false),
    /does not map/,
  )
})

test('requires each workspace to own its dist directory', () => {
  assert.equal(outDirError('dist'), undefined)
  assert.match(outDirError('../../dist'), /own dist directory/)
})
