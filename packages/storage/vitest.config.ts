import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // LL-7: storage suites contend on real file locks, fsync every write, and
    // spawn child writers. Serializing test files keeps the lock-heavy suites
    // from competing with sibling files on loaded CI runners; tests within a
    // file already run sequentially.
    fileParallelism: false,
  },
})
