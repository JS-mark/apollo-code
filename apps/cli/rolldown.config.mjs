import { readFileSync } from 'node:fs'

import { defineConfig } from 'rolldown'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const packageVersion = packageJson.version === '0.0.0' ? '0.0.0-dev+local' : packageJson.version
const version = process.env.APOLLO_BUILD_VERSION ?? packageVersion
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semverPattern.test(version) || version === '0.0.0')
  throw new Error(`APOLLO_BUILD_VERSION must be a non-placeholder SemVer, received: ${version}`)

const identity = {
  version,
  ...(process.env.APOLLO_BUILD_COMMIT ? { commit: process.env.APOLLO_BUILD_COMMIT } : {}),
  ...(process.env.APOLLO_BUILD_CHANNEL ? { channel: process.env.APOLLO_BUILD_CHANNEL } : {}),
  ...(process.env.APOLLO_BUILD_TIME ? { builtAt: process.env.APOLLO_BUILD_TIME } : {}),
}
const identityModuleSuffix = '/src/shared/build-identity.ts'

export default defineConfig({
  input: 'src/bin.ts',
  output: {
    codeSplitting: false,
    file: 'dist/apollo.js',
    format: 'esm',
  },
  platform: 'node',
  plugins: [
    {
      name: 'apollo-build-identity',
      load(id) {
        if (id.replaceAll('\\', '/').endsWith(identityModuleSuffix))
          return `export const buildIdentity = ${JSON.stringify(identity)}`
      },
    },
  ],
  treeshake: false,
})
