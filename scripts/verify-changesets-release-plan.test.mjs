import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const changesetBin = new URL('../node_modules/@changesets/cli/bin.js', import.meta.url)

const runChangesetStatus = (cwd, outputPath) =>
  spawnSync(process.execPath, [changesetBin.pathname, 'status', '--output', outputPath], {
    cwd,
    encoding: 'utf8',
  })

void test('Changesets builds the release plan and rejects deleted workspace packages', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'apollo-changesets-'))
  const validPlanPath = join(temporaryDirectory, 'release-plan.json')
  const worktreePath = join(temporaryDirectory, 'invalid-worktree')

  try {
    const validStatus = runChangesetStatus(root, validPlanPath)
    assert.equal(validStatus.status, 0, validStatus.stderr)

    const plan = JSON.parse(await readFile(validPlanPath, 'utf8'))
    assert.ok(plan.releases.length > 0)
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@apollo-code/native-fs-')))
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@apollo-code/native-sandbox-')))
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@apollo-code/native-search-')))

    const addWorktree = spawnSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(addWorktree.status, 0, addWorktree.stderr)

    await writeFile(
      join(worktreePath, '.changeset', 'deleted-native-package.md'),
      "---\n'@apollo-code/native-fs-darwin-arm64': patch\n---\n\nInvalid deleted package reference.\n",
    )

    const invalidStatus = runChangesetStatus(
      worktreePath,
      join(temporaryDirectory, 'invalid-plan.json'),
    )
    assert.notEqual(invalidStatus.status, 0)
    assert.match(invalidStatus.stderr, /not in the workspace/)
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: root })
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
})
