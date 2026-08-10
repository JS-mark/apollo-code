import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sourceRoot = dirname(fileURLToPath(import.meta.url))

describe('CLI dependency boundaries', () => {
  it('keeps domain commands independent from other command domains and runtime', async () => {
    const commandFiles = [
      'commands/doctor/index.ts',
      'commands/status/index.ts',
      'commands/telemetry/index.ts',
      'commands/trust/index.ts',
    ]

    for (const file of commandFiles) {
      const source = await readFile(resolve(sourceRoot, file), 'utf8')
      expect(source, relative(sourceRoot, resolve(sourceRoot, file))).not.toMatch(
        /from ['"](?:\.\.\/)+runtime(?:['"]|\/)/,
      )
      expect(source, relative(sourceRoot, resolve(sourceRoot, file))).not.toMatch(
        /from ['"](?:\.\.\/)+commands\//,
      )
    }
  })
})
