import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import { listInbox, runEntries, type InboxEntry } from '../src/cloudflare/inbox.ts'
import type { WorkKind } from '../src/cloudflare/labels.ts'
import { statusKeys } from '../src/cloudflare/status.ts'

type Item = { number: number; labels: string[]; pr?: boolean }

/** A GitHub stub with the installations, the repositories and the open items, and the path prefixes that fail with HTTP 500. */
function stub(installations: Record<number, string[]>, items: Record<string, Item[]>, broken: string[] = []) {
  const gh = (installation: number | null): GitHub => ({
    async json<T>(method: string, path: string): Promise<T> {
      const url = new URL(path, 'https://api.github.test')
      const at = installation === null ? path : path.replace(/^\/installation\//, `/installation/${installation}/`)
      if (broken.some((prefix) => at.startsWith(prefix))) throw new GitHubError(500, `GitHub ${method} ${path} answered HTTP 500`)
      const page = Number(url.searchParams.get('page'))
      if (page > 1) return (url.pathname === '/installation/repositories' ? { repositories: [] } : []) as T
      if (url.pathname === '/app/installations') return Object.keys(installations).map((id) => ({ id: Number(id) })) as T
      if (url.pathname === '/installation/repositories')
        return { repositories: (installations[installation ?? 0] ?? []).map((name) => ({ name: name.split('/')[1], owner: { login: name.split('/')[0] } })) } as T
      const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname)
      if (issues) {
        assert.equal(url.searchParams.get('state'), 'open')
        const label = url.searchParams.get('labels') ?? ''
        return (items[issues[1]!] ?? [])
          .filter((item) => item.labels.includes(label))
          .map((item) => ({ html_url: `https://github.test/${issues[1]}/${item.pr ? 'pull' : 'issues'}/${item.number}`, number: item.number, ...(item.pr ? { pull_request: {} } : {}) })) as T
      }
      throw new Error(`stub has no route ${method} ${path}`)
    },
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  })
  return { app: gh(null), installation: (id: number) => gh(id) }
}

/** Lists the inbox with the entries of each object: kind owner/repo#n. An object without entries gives none. */
async function inbox(github: ReturnType<typeof stub>, entries: Record<string, InboxEntry[] | Error>) {
  const asked: string[] = []
  const logs: string[] = []
  const result = await listInbox({
    ...github,
    entries: async (kind: WorkKind, owner, repo, number) => {
      const name = `${kind} ${owner}/${repo}#${number}`
      asked.push(name)
      const found = entries[name] ?? []
      if (found instanceof Error) throw found
      return found
    },
    log: (line) => logs.push(line),
  })
  return { asked, logs, result }
}

const ledgerOf = (values: Record<string, unknown>): Ledger => {
  const map = new Map(Object.entries(values))
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) }
}
const comment = { id: 1, url: 'https://github.test/acme/app/issues/5#issuecomment-1' }

test('the inbox lists one item of each kind, with the link of the issue or PR when the run has no link', async () => {
  const github = stub({ 1: ['acme/app'] }, {
    'acme/app': [
      { labels: ['agent-develop'], number: 5 },
      { labels: ['agent-research'], number: 6 },
      { labels: ['agent-review'], number: 7, pr: true },
      { labels: ['agent-develop'], number: 8 },
      { labels: ['agent-develop', 'agent-review'], number: 9 },
    ],
  })
  const { asked, result } = await inbox(github, {
    'develop acme/app#5': [{ cause: 'the questions intake wait for your /answer', kind: 'question', link: 'https://q' }],
    'develop acme/app#8': [{ cause: 'the run ended with failed', kind: 'failed', link: null }],
    'develop acme/app#9': [{ cause: 'PR #10 is ready and waits for your merge', kind: 'ready', link: 'https://pr/10' }],
    'research acme/app#6': [{ cause: 'the run ended with blocked', kind: 'blocked', link: 'https://b' }],
    'review acme/app#7': [{ cause: 'HTTP 403', kind: 'error', link: 'https://e' }],
  })
  assert.deepEqual(result.skipped, [])
  // The order of the work kinds in labels.ts, then the order of the list.
  assert.deepEqual(result.items, [
    { cause: 'the questions intake wait for your /answer', kind: 'question', link: 'https://q', number: 5, repository: 'acme/app' },
    { cause: 'the run ended with failed', kind: 'failed', link: 'https://github.test/acme/app/issues/8', number: 8, repository: 'acme/app' },
    { cause: 'PR #10 is ready and waits for your merge', kind: 'ready', link: 'https://pr/10', number: 9, repository: 'acme/app' },
    { cause: 'the run ended with blocked', kind: 'blocked', link: 'https://b', number: 6, repository: 'acme/app' },
    { cause: 'HTTP 403', kind: 'error', link: 'https://e', number: 7, repository: 'acme/app' },
  ])
  // Only a PR takes a review, and only an issue takes a development or a research run.
  assert.ok(!asked.includes('review acme/app#9'), asked.join('\n'))
})

test('a failed installation, repository or item goes to skipped, and the other items stay in the list', async () => {
  const github = stub(
    { 1: ['acme/lost'], 2: ['acme/bad', 'acme/app'] },
    { 'acme/app': [{ labels: ['agent-develop'], number: 5 }, { labels: ['agent-develop'], number: 6 }] },
    ['/installation/1/repositories', '/repos/acme/bad/issues'],
  )
  const { result } = await inbox(github, {
    'develop acme/app#5': new Error('the object failed'),
    'develop acme/app#6': [{ cause: 'HTTP 403', kind: 'error', link: 'https://e' }],
  })
  assert.deepEqual(result.items, [{ cause: 'HTTP 403', kind: 'error', link: 'https://e', number: 6, repository: 'acme/app' }])
  assert.equal(result.skipped.length, 5, JSON.stringify(result.skipped))
  assert.equal(result.skipped[0]?.what, 'installation 1')
  assert.match(result.skipped[0]?.reason ?? '', /HTTP 500/)
  // One for each label list of acme/bad.
  assert.deepEqual(result.skipped.slice(1, 4).map((skip) => skip.what), ['acme/bad', 'acme/bad', 'acme/bad'])
  assert.match(result.skipped[1]?.reason ?? '', /agent-develop items failed: .*HTTP 500/)
  assert.deepEqual(result.skipped[4], { reason: 'the develop run cannot be read: the object failed', what: 'acme/app#5' })
})

test('the inbox is empty when nothing waits, and a failed list of the installations goes to skipped', async () => {
  const empty = await inbox(stub({ 1: ['acme/app'] }, { 'acme/app': [{ labels: ['agent-develop'], number: 5 }] }), {})
  assert.deepEqual(empty.result, { items: [], skipped: [] })
  assert.deepEqual(empty.asked, ['develop acme/app#5'])
  const lost = await inbox(stub({}, {}, ['/app/installations']), {})
  assert.equal(lost.result.items.length, 0)
  assert.equal(lost.result.skipped[0]?.what, 'the installations')
})

test('a working run gives its open user question batches, but no answered batch and no once() key', () => {
  const ledger = ledgerOf({
    'answers:plan': [],
    'posted:intake': { at: 't', batch: 'intake', ref: 'https://q/intake' },
    'posted:label': true,
    'posted:plan': { at: 't', batch: 'plan', ref: 'https://q/plan' },
  })
  const expected = [{ cause: 'the questions intake wait for your /answer', kind: 'question', link: 'https://q/intake' }]
  for (const state of ['queued', 'running', 'paused'] as const) assert.deepEqual(runEntries({ note: '', state }, ledger, ['intake', 'label', 'plan']), expected)
})

test('a stopped run gives error with its note and the link of the comment that needs the user, else of the status comment', () => {
  assert.deepEqual(runEntries({ note: 'HTTP 403', state: 'error' }, ledgerOf({ [statusKeys.comment]: comment, [statusKeys.view]: { link: 'https://stop', state: 'error' } }), []), [
    { cause: 'HTTP 403', kind: 'error', link: 'https://stop' },
  ])
  assert.deepEqual(runEntries({ note: 'HTTP 403', state: 'error' }, ledgerOf({ [statusKeys.comment]: comment }), []), [{ cause: 'HTTP 403', kind: 'error', link: comment.url }])
  // A run that stopped before its first post has no link.
  assert.deepEqual(runEntries({ note: 'HTTP 401', state: 'error' }, ledgerOf({ 'posted:intake': { ref: 'https://q' } }), ['intake']), [{ cause: 'HTTP 401', kind: 'error', link: null }])
})

test('a failed run gives blocked for a blocked result, else failed, with the link of its summary', () => {
  const summary = { [statusKeys.comment]: comment, [statusKeys.summary]: 'https://summary' }
  assert.deepEqual(runEntries({ note: '', state: 'failed' }, ledgerOf({ ...summary, result: { merge: null, pr: null, status: 'blocked' } }), []), [
    { cause: 'the run ended with blocked', kind: 'blocked', link: 'https://summary' },
  ])
  assert.deepEqual(runEntries({ note: '', state: 'failed' }, ledgerOf({ ...summary, result: { status: 'failed' } }), []), [{ cause: 'the run ended with failed', kind: 'failed', link: 'https://summary' }])
  // A review result has pass and no status.
  assert.deepEqual(runEntries({ note: '', state: 'failed' }, ledgerOf({ [statusKeys.comment]: comment, result: { pass: false } }), []), [{ cause: 'the run ended with FAIL', kind: 'failed', link: comment.url }])
})

test('a passed run gives ready for a ready PR without a merge, and nothing for a merged PR or a review', () => {
  const pr = { number: 10, url: 'https://pr/10' }
  const ready = [{ cause: 'PR #10 is ready and waits for your merge', kind: 'ready', link: 'https://pr/10' }]
  assert.deepEqual(runEntries({ note: '', state: 'passed' }, ledgerOf({ result: { merge: null, pr, status: 'ready' } }), []), ready)
  // A research result has no merge field.
  assert.deepEqual(runEntries({ note: '', state: 'passed' }, ledgerOf({ result: { pr, status: 'ready' } }), []), ready)
  assert.deepEqual(runEntries({ note: '', state: 'passed' }, ledgerOf({ result: { merge: { method: 'squash', sha: 'a' }, pr, status: 'ready' } }), []), [])
  assert.deepEqual(runEntries({ note: '', state: 'passed' }, ledgerOf({ result: { pr: null, status: 'ready' } }), []), [])
  assert.deepEqual(runEntries({ note: '', state: 'passed' }, ledgerOf({ result: { pass: true } }), []), [])
})
