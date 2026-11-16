import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import { sweepBranches, type RunLookup, type State } from '../src/cloudflare/prune.ts'

type PullView = { state: 'open' | 'closed'; merged: boolean; body: string; head: string }
type Setup = {
  /** The factory/* branches on GitHub, with their heads. */
  refs: Record<string, string>
  /** The PRs by number. `head` is the head branch, whose PR list query finds the PR. */
  pulls?: Record<number, PullView>
  /** The pairs base...sha where sha is in base. */
  contains?: string[]
  /** The runs that the objects know, by name. */
  runs?: Record<string, { state: State; ship?: boolean }>
  /** The branch names whose delete GitHub refuses. */
  refuse?: string[]
  /** The paths that fail with HTTP 500. */
  broken?: string[]
}

const api = '/repos/acme/app'

/** A GitHub stub that answers the calls of the sweep from `setup`, and records each call and each delete. */
function sweep(setup: Setup, only?: (name: string) => boolean) {
  const calls: string[] = []
  const deleted: string[] = []
  const lookups: Parameters<RunLookup>[] = []
  const pulls = Object.entries(setup.pulls ?? {})
  const view = ([number, pull]: [string, PullView]) => ({
    body: pull.body,
    head: { ref: pull.head, sha: setup.refs[pull.head] ?? `sha-of-${pull.head}` },
    merged: pull.merged,
    merged_at: pull.merged ? '2026-11-16T12:00:00Z' : null,
    number: Number(number),
    state: pull.state,
  })
  const gh: GitHub = {
    async json<T>(method: string, path: string): Promise<T> {
      calls.push(`${method} ${path}`)
      const url = new URL(path, 'https://api.github.test')
      if (setup.broken?.some((broken) => path.startsWith(broken))) throw new GitHubError(500, `GitHub ${method} ${path} answered HTTP 500`)
      if (method === 'GET' && url.pathname === `${api}/git/matching-refs/heads/factory/`) {
        const refs = Object.entries(setup.refs).map(([name, sha]) => ({ object: { sha }, ref: `refs/heads/${name}` }))
        const page = Number(url.searchParams.get('page'))
        const size = Number(url.searchParams.get('per_page'))
        return refs.slice((page - 1) * size, page * size) as T
      }
      if (method === 'GET' && url.pathname === api) return { default_branch: 'main' } as T
      if (method === 'GET' && url.pathname === `${api}/pulls`) {
        assert.equal(url.searchParams.get('state'), 'all')
        const head = url.searchParams.get('head')!.replace(/^acme:/, '')
        // The list has no merged field, as on GitHub: merged_at gives the merge.
        return pulls.filter(([, pull]) => pull.head === head).map((entry) => ({ ...view(entry), merged: undefined })) as T
      }
      const pull = new RegExp(`^${api}/pulls/(\\d+)$`).exec(url.pathname)
      if (method === 'GET' && pull) {
        const found = pulls.find(([number]) => number === pull[1])
        if (!found) throw new GitHubError(404, 'Not Found')
        return view(found) as T
      }
      if (method === 'GET' && url.pathname.startsWith(`${api}/compare/`)) {
        const pair = decodeURIComponent(url.pathname.slice(`${api}/compare/`.length))
        const sha = pair.split('...')[1]!
        return { merge_base_commit: { sha: setup.contains?.includes(pair) ? sha : 'other' } } as T
      }
      if (method === 'DELETE' && url.pathname.startsWith(`${api}/git/refs/heads/`)) {
        const name = decodeURIComponent(url.pathname.slice(`${api}/git/refs/heads/`.length))
        if (setup.refuse?.includes(name)) throw new GitHubError(403, `GitHub DELETE ${path} answered HTTP 403: protected`)
        deleted.push(name)
        return undefined as T
      }
      throw new Error(`stub has no route ${method} ${path}`)
    },
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  }
  const lookup: RunLookup = async (...args) => {
    lookups.push(args)
    const found = setup.runs?.[args[2]]
    return found ? { ship: found.ship ?? false, state: found.state } : null
  }
  return { calls, deleted, lookups, result: sweepBranches({ gh, lookup, owner: 'acme', repo: 'app', ...(only ? { only } : {}) }) }
}

const devBody = (run: string) => `agent-factory run \`${run}\` (acme/app#5) opened this draft PR.`

test('the sweep deletes the branch of a merged development PR and the review fix branch of the merged PR', async () => {
  const run = sweep({
    pulls: { 9: { body: devBody('dev-5-20261116-1200'), head: 'factory/dev-add', merged: true, state: 'closed' } },
    refs: { 'factory/dev-add': 'd1', 'factory/pr-9-20261116-1300': 'r1' },
    runs: { 'dev-5-20261116-1200': { state: 'passed' }, 'pr-9-20261116-1300': { state: 'passed' } },
  })
  const result = await run.result
  assert.deepEqual(result.deleted, [
    { name: 'factory/dev-add', rule: 'merged' },
    { name: 'factory/pr-9-20261116-1300', rule: 'merged' },
  ])
  assert.deepEqual(run.deleted, ['factory/dev-add', 'factory/pr-9-20261116-1300'])
  assert.deepEqual(run.lookups, [
    ['develop', 5, 'dev-5-20261116-1200'],
    ['review', 9, 'pr-9-20261116-1300'],
  ])
})

test('the sweep deletes a review fix branch whose head is in the PR head as applied', async () => {
  const run = sweep({
    contains: ['sha-of-feature...r1'],
    pulls: { 9: { body: '', head: 'feature', merged: false, state: 'open' } },
    refs: { 'factory/pr-9-1': 'r1', 'factory/pr-9-2': 'r2' },
    runs: { 'pr-9-1': { ship: true, state: 'passed' }, 'pr-9-2': { ship: true, state: 'passed' } },
  })
  const result = await run.result
  assert.deepEqual(result.deleted, [{ name: 'factory/pr-9-1', rule: 'applied' }])
  assert.deepEqual(result.kept, [{ name: 'factory/pr-9-2', reason: 'open PR' }])
})

test('the sweep deletes the branches of a PR closed without a merge as stranded', async () => {
  const run = sweep({
    pulls: {
      9: { body: devBody('dev-5-1'), head: 'factory/dev-add', merged: false, state: 'closed' },
      11: { body: '', head: 'feature', merged: false, state: 'closed' },
    },
    refs: { 'factory/dev-add': 'd1', 'factory/pr-11-1': 'r1' },
    runs: { 'dev-5-1': { state: 'failed' }, 'pr-11-1': { state: 'failed' } },
  })
  assert.deepEqual((await run.result).deleted, [
    { name: 'factory/dev-add', rule: 'stranded' },
    { name: 'factory/pr-11-1', rule: 'stranded' },
  ])
})

test('the sweep keeps an open PR, a run that is not finished, a run in state error, and unapplied review fixes', async () => {
  const run = sweep({
    pulls: {
      9: { body: devBody('dev-5-1'), head: 'factory/dev-add', merged: false, state: 'open' },
      11: { body: '', head: 'feature', merged: false, state: 'open' },
      12: { body: '', head: 'other', merged: false, state: 'closed' },
    },
    refs: { 'factory/dev-add': 'd1', 'factory/pr-11-1': 'r1', 'factory/pr-11-2': 'r2', 'factory/pr-12-1': 'r3', 'factory/pr-12-2': 'r4' },
    runs: { 'dev-5-1': { state: 'passed' }, 'pr-11-1': { state: 'passed' }, 'pr-11-2': { state: 'running' }, 'pr-12-1': { state: 'error' }, 'pr-12-2': { state: 'paused' } },
  })
  const result = await run.result
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(result.kept, [
    { name: 'factory/dev-add', reason: 'open PR' },
    { name: 'factory/pr-11-1', reason: 'unapplied review fixes' },
    { name: 'factory/pr-11-2', reason: 'run not finished' },
    { name: 'factory/pr-12-1', reason: 'run not finished' },
    { name: 'factory/pr-12-2', reason: 'run not finished' },
  ])
  assert.deepEqual(run.deleted, [])
})

test('the sweep deletes a branch of no known run only when no PR is open for it and its head is in the default branch', async () => {
  const run = sweep({
    contains: ['main...o1'],
    pulls: { 9: { body: 'no run ID', head: 'factory/open', merged: false, state: 'open' } },
    refs: { 'factory/old': 'o1', 'factory/new': 'n1', 'factory/open': 'o1', 'factory/dev-gone': 'g1', 'factory/task-dev-5-1-a': 'n1' },
  })
  const result = await run.result
  assert.deepEqual(result.deleted, [{ name: 'factory/old', rule: 'merged' }])
  assert.deepEqual(result.kept, [
    { name: 'factory/new', reason: 'unknown run' },
    { name: 'factory/open', reason: 'unknown run' },
    { name: 'factory/dev-gone', reason: 'unknown run' },
    { name: 'factory/task-dev-5-1-a', reason: 'unknown run' },
  ])
  // The default branch is read one time for the whole sweep.
  assert.equal(run.calls.filter((call) => call === `GET ${api}`).length, 1)
})

test('the sweep never deletes a branch outside factory/, also when only selects it', async () => {
  const run = sweep({ pulls: { 9: { body: '', head: 'main', merged: true, state: 'closed' } }, refs: { main: 'm1', 'factory/pr-9-1': 'r1' }, runs: { 'pr-9-1': { state: 'passed' } } }, (name) => name === 'main')
  const result = await run.result
  assert.deepEqual(result, { deleted: [], failed: [], kept: [{ name: 'main', reason: 'outside factory/' }] })
  assert.deepEqual(run.deleted, [])
  assert.ok(!run.calls.some((call) => call.startsWith('DELETE') || call.includes('/pulls')), run.calls.join('\n'))
})

test('a refused delete goes to failed, a GitHub error keeps its branch, and the sweep goes on', async () => {
  const run = sweep({
    broken: [`${api}/pulls/13`],
    pulls: { 9: { body: '', head: 'feature', merged: true, state: 'closed' }, 13: { body: '', head: 'fix', merged: true, state: 'closed' } },
    refs: { 'factory/pr-9-1': 'r1', 'factory/pr-13-1': 'r3', 'factory/pr-9-2': 'r2' },
    refuse: ['factory/pr-9-1'],
    runs: { 'pr-9-1': { state: 'passed' }, 'pr-9-2': { state: 'failed' }, 'pr-13-1': { state: 'passed' } },
  })
  const result = await run.result
  assert.deepEqual(result.deleted, [{ name: 'factory/pr-9-2', rule: 'merged' }])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0]!.name, 'factory/pr-9-1')
  assert.match(result.failed[0]!.reason, /HTTP 403: protected/)
  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0]!.name, 'factory/pr-13-1')
  assert.match(result.kept[0]!.reason, /^facts not read: .*HTTP 500/)
})

test('the sweep reads every page of the branch list, and only limits the branches', async () => {
  const refs = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`factory/x-${index}`, `s${index}`]))
  const run = sweep({ refs }, (name) => name === 'factory/x-100')
  const result = await run.result
  assert.deepEqual(result.kept, [{ name: 'factory/x-100', reason: 'unknown run' }])
  assert.deepEqual(
    run.calls.filter((call) => call.includes('matching-refs')),
    [1, 2].map((page) => `GET ${api}/git/matching-refs/heads/factory/?per_page=100&page=${page}`),
  )
})
