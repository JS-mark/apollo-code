import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relativeSpecifierError, outDirError } from './verify-typescript-config.mjs'

test('accepts a .js specifier when it maps to emitted TypeScript source', () => {
  assert.equal(relativeSpecifierError('/repo/src/cli.ts', './ports.js', path => path === '/repo/src/ports.ts'), undefined)
})

test('rejects source extensions, extensionless specifiers, and missing targets', () => {
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './ports.ts'), /source extension/)
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './ports'), /no supported runtime extension/)
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './missing.js', () => false), /does not map/)
})

test('requires each workspace to own its dist directory', () => {
  assert.equal(outDirError('dist'), undefined)
  assert.match(outDirError('../../dist'), /own dist directory/)
})
