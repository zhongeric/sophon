import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { git, gitBranches, gitRepo, worktreePath } from '../src/node/git.ts'
import { developRepo } from './support/develop.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))
const hasBranch = async (repo: string, name: string) =>
  git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).then(
    () => true,
    () => false,
  )

test('Node branches: deleteLocal removes the worktree and the branch, also outside the run directory', async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const branches = gitBranches(repo, dir)
  await branches.branch('factory/task-a', 'main')
  const tree = worktreePath(dir, 'factory/task-a')
  assert.ok(existsSync(tree))
  await branches.deleteLocal('factory/task-a')
  assert.ok(!existsSync(tree))
  assert.equal(await hasBranch(repo, 'factory/task-a'), false)

  // A review pass worktree is in runs/<run>-review-<pass>/tree, outside the directory of the branches.
  const outside = join(runsDir(), 'tree')
  await git(repo, 'worktree', 'add', '-b', 'factory/dev-x-review-1', outside, 'main')
  await branches.deleteLocal('factory/dev-x-review-1')
  assert.ok(!existsSync(outside))
  assert.equal(await hasBranch(repo, 'factory/dev-x-review-1'), false)

  // A worktree without its directory does not block the delete.
  await branches.branch('factory/task-b', 'main')
  rmSync(worktreePath(dir, 'factory/task-b'), { recursive: true, force: true })
  await branches.deleteLocal('factory/task-b')
  assert.equal(await hasBranch(repo, 'factory/task-b'), false)
})

test('Node branches: deleteLocal of an absent branch is not an error', async () => {
  const { repo } = developRepo()
  await gitBranches(repo, runsDir()).deleteLocal('factory/absent')
})

test('Node branches: release removes the worktrees of the run and keeps the branches', async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const branches = gitBranches(repo, dir)
  const branch = await branches.branch('factory/task-a', 'main')
  await branch.tree.write('/src/sub.ts', new TextEncoder().encode('export const sub = 1\n'))
  await branch.commit('add sub')
  const head = await branch.head()
  const view = join(dir, `view-${head.slice(0, 12)}`)
  await branches.view(head)
  assert.ok(existsSync(view))
  const outside = join(runsDir(), 'tree')
  await git(repo, 'worktree', 'add', '-b', 'factory/other', outside, 'main')

  await branches.release()
  assert.ok(!existsSync(worktreePath(dir, 'factory/task-a')))
  assert.ok(!existsSync(view))
  assert.ok(existsSync(outside))
  assert.equal((await git(repo, 'rev-parse', 'refs/heads/factory/task-a')).trim(), head)
  // The branch opens again in a new worktree.
  assert.equal(await (await branches.branch('factory/task-a', 'main')).head(), head)
})

test('Node repo: release keeps the fix branch, a resumed run recreates the worktree, and deleteBranch removes it everywhere', async () => {
  const { repo, origin } = developRepo()
  const tree = join(runsDir(), 'tree')
  const source = { repo, base: 'main', head: 'main' }
  const run = gitRepo(source, tree, 'factory/pr-7-x')
  const frozen = await run.freeze()
  await run.tree.write('/src/fix.ts', new TextEncoder().encode('export const fix = 1\n'))
  await run.commit('fix')
  const fixed = await run.head()

  await run.release()
  assert.ok(!existsSync(tree))
  assert.equal((await git(repo, 'rev-parse', 'refs/heads/factory/pr-7-x')).trim(), fixed)

  // The freeze step is in the ledger, so a resumed run starts with a git method on a new Repo.
  const resumed = gitRepo(source, tree, 'factory/pr-7-x')
  assert.deepEqual(await resumed.touchedFiles(frozen.base, fixed), ['src/fix.ts'])
  assert.equal(await resumed.head(), fixed)
  assert.equal(new TextDecoder().decode(await resumed.tree.read('/src/fix.ts')), 'export const fix = 1\n')

  await git(repo, 'push', 'origin', 'refs/heads/factory/pr-7-x')
  await resumed.deleteBranch()
  assert.ok(!existsSync(tree))
  assert.equal(await hasBranch(repo, 'factory/pr-7-x'), false)
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/factory/pr-7-x'))

  // An absent branch counts as deleted, also in a repository without origin.
  await resumed.deleteBranch()
  await git(repo, 'remote', 'remove', 'origin')
  await resumed.deleteBranch()
})
