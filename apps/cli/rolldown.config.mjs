import { defineConfig } from 'rolldown'

export default defineConfig({
  input: 'src/bin.ts',
  output: {
    codeSplitting: false,
    file: 'dist/apollo.js',
    format: 'esm',
  },
  platform: 'node',
  treeshake: false,
})
