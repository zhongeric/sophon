import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchesSection, classifyBranch, pruneBranches } from '../src/core/prune.ts'
import type { BranchFacts, BranchRun } from '../src/core/prune.ts'

const run = (kind: BranchRun['kind'], extra: Partial<BranchRun> = {}): BranchRun => ({ kind, finished: true, ship: false, ...extra })
const facts = (extra: Partial<BranchFacts> = {}): BranchFacts => ({
  name: 'factory/dev-7-1',
  run: run('develop'),
  pr: null,
  applied: false,
  inDefault: false,
  ...extra,
})

test('a branch of a merged PR is merged', () => {
  assert.equal(classifyBranch(facts({ pr: 'merged' })).rule, 'merged')
  assert.equal(classifyBranch(facts({ name: 'factory/pr-3-1', run: run('review'), pr: 'merged' })).rule, 'merged')
})

test('a branch whose head is in the PR branch or a development branch is applied', () => {
  assert.equal(classifyBranch(facts({ name: 'factory/pr-3-1', run: run('review'), pr: 'open', applied: true })).rule, 'applied')
  assert.equal(classifyBranch(facts({ name: 'factory/dev-7-1-task-a', run: run('task'), applied: true })).rule, 'applied')
})

test('a finished run without a PR, and a PR closed without a merge, are stranded', () => {
  assert.equal(classifyBranch(facts()).rule, 'stranded')
  assert.equal(classifyBranch(facts({ run: run('task') })).rule, 'stranded')
  assert.equal(classifyBranch(facts({ pr: 'closed' })).rule, 'stranded')
  assert.equal(classifyBranch(facts({ name: 'factory/pr-3-1', run: run('review'), pr: 'closed' })).rule, 'stranded')
})

test('a branch with an open PR is kept', () => {
  assert.deepEqual(classifyBranch(facts({ pr: 'open' })), { rule: 'kept', reason: 'open PR' })
  assert.deepEqual(classifyBranch(facts({ name: 'factory/pr-3-1', run: run('review', { ship: true }), pr: 'open' })), { rule: 'kept', reason: 'open PR' })
})

test('a branch of a run that is not finished is kept, also when its PR merged', () => {
  assert.deepEqual(classifyBranch(facts({ run: run('develop', { finished: false }), pr: 'merged', applied: true })), { rule: 'kept', reason: 'run not finished' })
})

test('unapplied review fixes are kept while the PR is open or when there is no PR', () => {
  const review = { name: 'factory/pr-3-1', run: run('review') }
  assert.deepEqual(classifyBranch(facts({ ...review, pr: 'open' })), { rule: 'kept', reason: 'unapplied review fixes' })
  assert.deepEqual(classifyBranch(facts({ ...review, name: 'factory/run-1', pr: null })), { rule: 'kept', reason: 'unapplied review fixes' })
})

test('a branch of an unknown run goes only without an open PR and with its head in the default branch', () => {
  const unknown = { name: 'factory/old', run: null }
  assert.equal(classifyBranch(facts({ ...unknown, inDefault: true })).rule, 'merged')
  assert.equal(classifyBranch(facts({ ...unknown, pr: 'merged', inDefault: true })).rule, 'merged')
  assert.deepEqual(classifyBranch(facts({ ...unknown, pr: 'open', inDefault: true })), { rule: 'kept', reason: 'unknown run' })
  assert.deepEqual(classifyBranch(facts({ ...unknown, inDefault: false })), { rule: 'kept', reason: 'unknown run' })
  assert.deepEqual(classifyBranch(facts({ ...unknown, pr: 'closed' })), { rule: 'kept', reason: 'unknown run' })
})

test('a branch outside factory/ is kept, also when it is the head of a merged PR', () => {
  assert.deepEqual(classifyBranch(facts({ name: 'feature/x', pr: 'merged', applied: true, inDefault: true })), { rule: 'kept', reason: 'outside factory/' })
  assert.deepEqual(classifyBranch(facts({ name: 'feature/factory/x', run: null, inDefault: true })), { rule: 'kept', reason: 'outside factory/' })
})

test('a failed delete goes to failed as one line, and the other deletes go on', async () => {
  const removed: string[] = []
  const result = await pruneBranches(
    [
      facts({ name: 'factory/a', pr: 'merged' }),
      facts({ name: 'factory/b', pr: 'closed' }),
      facts({ name: 'factory/c', pr: 'open' }),
      facts({ name: 'factory/d', run: run('task'), applied: true }),
    ],
    async (name) => {
      if (name === 'factory/b') throw new Error('refused:\n  protected branch')
      removed.push(name)
    },
  )
  assert.deepEqual(removed, ['factory/a', 'factory/d'])
  assert.deepEqual(result, {
    deleted: [
      { name: 'factory/a', rule: 'merged' },
      { name: 'factory/d', rule: 'applied' },
    ],
    kept: [{ name: 'factory/c', reason: 'open PR' }],
    failed: [{ name: 'factory/b', reason: 'refused: protected branch' }],
  })
})

test('the Branches section lists the deletes and the failed deletes, and is empty without them', () => {
  assert.deepEqual(
    branchesSection({
      deleted: [{ name: 'factory/a', rule: 'merged' }],
      kept: [{ name: 'factory/c', reason: 'open PR' }],
      failed: [{ name: 'factory/b', reason: 'refused' }],
    }),
    ['## Branches', '', '- deleted factory/a (merged)', '- not deleted factory/b: refused', ''],
  )
  assert.deepEqual(branchesSection({ deleted: [], kept: [{ name: 'factory/c', reason: 'open PR' }], failed: [] }), [])
})
