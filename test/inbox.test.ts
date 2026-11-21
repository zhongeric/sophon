import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import { inboxEntries, listInbox, type InboxEntry, type InboxRun } from '../src/cloudflare/inbox.ts'
import type { WorkKind } from '../src/cloudflare/labels.ts'

const issueLink = 'https://github.com/acme/app/issues/5'
const statusLink = 'https://github.com/acme/app/issues/5#issuecomment-1'
const prLink = 'https://github.com/acme/app/pull/6'

const ledgerOf = (values: Record<string, unknown>): Pick<Ledger, 'get'> => ({ get: <T>(key: string) => values[key] as T | undefined })
const row = (state: InboxRun['state'], note = ''): InboxRun => ({ link: issueLink, note, run: 'dev-5-1', state })
const status = { 'status-comment': { id: 1, url: statusLink } }

test('a paused run with an open user question batch gives a question with the batch link', () => {
  const posted = [{ at: '2026-01-01T00:00:00Z', batch: 'intake', ref: `${issueLink}#issuecomment-2` }, true]
  assert.deepEqual(inboxEntries(row('paused', 'waiting for your answers'), ledgerOf(status), posted), [
    { kind: 'question', link: `${issueLink}#issuecomment-2`, reason: 'the questions intake wait for your /answer comment', run: 'dev-5-1' },
  ])
})

test('a failed, blocked, error or ready run gives one entry of its kind', () => {
  const failed = { attention: { kind: 'failed', reason: 'the run failed', url: `${issueLink}#issuecomment-3` }, ...status }
  const blocked = { attention: { kind: 'blocked', reason: 'the run is blocked', url: `${issueLink}#issuecomment-4` }, ...status }
  const error = { attention: { kind: 'error', reason: 'HTTP 403', url: `${issueLink}#issuecomment-5` }, ...status }
  const ready = { attention: { kind: 'ready', reason: 'the host did not merge the PR', url: prLink }, ...status }
  const shipped = { attention: { kind: 'ready', reason: 'the PR passed the review and waits for a merge', url: prLink } }
  const one = (kind: InboxEntry['kind'], reason: string, link: string) => [{ kind, link, reason, run: 'dev-5-1' }]
  assert.deepEqual(inboxEntries(row('failed'), ledgerOf(failed), []), one('failed', 'the run failed', `${issueLink}#issuecomment-3`))
  assert.deepEqual(inboxEntries(row('failed'), ledgerOf(blocked), []), one('blocked', 'the run is blocked', `${issueLink}#issuecomment-4`))
  assert.deepEqual(inboxEntries(row('error', 'GitHub answered HTTP 403'), ledgerOf(error), [true]), one('error', 'GitHub answered HTTP 403', `${issueLink}#issuecomment-5`))
  // An unmerged development PR, and a review PR that --ship marked ready.
  assert.deepEqual(inboxEntries(row('passed'), ledgerOf(ready), [true]), one('ready', 'the host did not merge the PR', prLink))
  assert.deepEqual(inboxEntries({ ...row('passed'), link: prLink }, ledgerOf(shipped), []), one('ready', 'the PR passed the review and waits for a merge', prLink))
})

test('an error without an attention record links the status comment, else the issue', () => {
  assert.deepEqual(inboxEntries(row('error', 'stopped'), ledgerOf(status), [])[0]?.link, statusLink)
  assert.deepEqual(inboxEntries(row('error', 'stopped'), ledgerOf({}), [])[0]?.link, issueLink)
})

test('a passed, running, queued or CI-paused run and an answered batch give nothing', () => {
  const batch = { at: '2026-01-01T00:00:00Z', batch: 'intake', ref: `${issueLink}#issuecomment-2` }
  assert.deepEqual(inboxEntries(row('passed'), ledgerOf({ attention: null, ...status }), [true]), [])
  assert.deepEqual(inboxEntries(row('running'), ledgerOf(status), [batch]), [])
  assert.deepEqual(inboxEntries(row('queued'), ledgerOf(status), [batch]), [])
  assert.deepEqual(inboxEntries(row('paused', 'waiting for CI'), ledgerOf(status), [true]), [])
  assert.deepEqual(inboxEntries(row('paused'), ledgerOf({ 'answers:intake': [], ...status }), [batch]), [])
  // A review that a development run started has no attention: its parent run carries the result.
  assert.deepEqual(inboxEntries(row('failed'), ledgerOf({ attention: null }), []), [])
})

type Item = { number: number; labels: string[]; pr?: boolean; closed?: boolean }

/** A GitHub stub that answers each issue list with the open items of the repository that have the label of the query. */
function world(setup: { installations: Record<number, string[]>; items: Record<string, Item[]>; broken?: string[] }) {
  const page = <T>(url: URL, all: T[]) => {
    const number = Number(url.searchParams.get('page'))
    const size = Number(url.searchParams.get('per_page'))
    return all.slice((number - 1) * size, number * size)
  }
  const reads: string[] = []
  const client = (id: number | null): GitHub => ({
    async json<T>(method: string, path: string): Promise<T> {
      reads.push(path)
      const url = new URL(path, 'https://api.github.test')
      if (setup.broken?.some((broken) => url.pathname.startsWith(broken))) throw new GitHubError(500, `GitHub ${method} ${path} answered HTTP 500`)
      if (url.pathname === '/app/installations' && id === null) return page(url, Object.keys(setup.installations).map((key) => ({ id: Number(key) }))) as T
      if (url.pathname === '/installation/repositories' && id !== null) {
        const repositories = (setup.installations[id] ?? []).map((name) => ({ name: name.split('/')[1], owner: { login: name.split('/')[0] } }))
        return { repositories: page(url, repositories), total_count: repositories.length } as T
      }
      const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname)
      if (issues) {
        assert.equal(url.searchParams.get('state'), 'open')
        const label = url.searchParams.get('labels') ?? ''
        const all = (setup.items[issues[1]!] ?? [])
          .filter((item) => !item.closed && item.labels.includes(label))
          .map((item) => ({ number: item.number, ...(item.pr ? { pull_request: { url: 'x' } } : {}) }))
        return page(url, all) as T
      }
      throw new Error(`stub has no route ${method} ${path}`)
    },
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  })
  return { client, reads }
}

test('the listing gives one item of each kind with links, reads all pages, and names a repository that failed', async () => {
  const develop = (number: number): Item => ({ labels: ['agent-develop'], number })
  const stub = world({
    broken: ['/repos/acme/broken/'],
    installations: { 1: ['acme/app', 'acme/broken'], 2: ['acme/lib'] },
    items: {
      // 150 items, so that the questions of #150 are on the second page.
      'acme/app': [
        ...Array.from({ length: 149 }, (_, index) => develop(index + 1)),
        develop(150),
        { labels: ['agent-research'], number: 151 },
        { labels: ['agent-review'], number: 152, pr: true },
        { closed: true, labels: ['agent-develop'], number: 153 },
        { labels: ['bug'], number: 154 },
        { labels: ['agent-review'], number: 155 },
        { labels: ['agent-develop'], number: 156, pr: true },
      ],
      'acme/lib': [{ labels: ['agent-develop'], number: 3 }],
    },
  })
  const asked: string[] = []
  const found: Record<string, InboxEntry[]> = {
    'develop acme/app#150': [{ kind: 'question', link: 'https://github.com/acme/app/issues/150#issuecomment-1', reason: 'questions', run: 'dev-150' }],
    'research acme/app#151': [{ kind: 'blocked', link: 'https://github.com/acme/app/issues/151#issuecomment-2', reason: 'blocked', run: 'res-151' }],
    'review acme/app#152': [{ kind: 'ready', link: 'https://github.com/acme/app/pull/152', reason: 'ready', run: 'pr-152' }],
    'develop acme/lib#3': [
      { kind: 'failed', link: 'https://github.com/acme/lib/issues/3#issuecomment-3', reason: 'failed', run: 'dev-3' },
      { kind: 'error', link: 'https://github.com/acme/lib/issues/3#issuecomment-4', reason: 'HTTP 403', run: 'dev-3' },
    ],
  }
  const logs: string[] = []
  const inbox = await listInbox({
    app: stub.client(null),
    entries: async (kind: WorkKind, owner, repo, number) => {
      const name = `${kind} ${owner}/${repo}#${number}`
      asked.push(name)
      return found[name] ?? []
    },
    installation: (id) => stub.client(id),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(inbox.items, [
    { kind: 'question', link: 'https://github.com/acme/app/issues/150#issuecomment-1', number: 150, reason: 'questions', repository: 'acme/app', run: 'dev-150' },
    { kind: 'blocked', link: 'https://github.com/acme/app/issues/151#issuecomment-2', number: 151, reason: 'blocked', repository: 'acme/app', run: 'res-151' },
    { kind: 'ready', link: 'https://github.com/acme/app/pull/152', number: 152, reason: 'ready', repository: 'acme/app', run: 'pr-152' },
    { kind: 'failed', link: 'https://github.com/acme/lib/issues/3#issuecomment-3', number: 3, reason: 'failed', repository: 'acme/lib', run: 'dev-3' },
    { kind: 'error', link: 'https://github.com/acme/lib/issues/3#issuecomment-4', number: 3, reason: 'HTTP 403', repository: 'acme/lib', run: 'dev-3' },
  ])
  // Closed and unlabeled items, a review label on an issue and a develop label on a PR ask no object.
  for (const skipped of ['#153', '#154', '#155', '#156']) assert.ok(!asked.some((name) => name.endsWith(skipped)), skipped)
  assert.ok(stub.reads.some((path) => path.startsWith('/repos/acme/app/issues?') && path.includes('page=2')))
  assert.equal(inbox.failed.length, 3)
  for (const failure of inbox.failed) assert.equal(failure.repository, 'acme/broken')
  assert.match(inbox.failed[0]!.reason, /cannot list the agent-develop items: .*HTTP 500/)
  assert.deepEqual(logs, [])
})

test('a failed installation, a failed object and a failed installation list are named', async () => {
  const stub = world({ broken: ['/installation/repositories'], installations: { 1: ['acme/app'] }, items: {} })
  const inbox = await listInbox({ app: stub.client(null), entries: async () => [], installation: (id) => stub.client(id), log: () => {} })
  assert.deepEqual(inbox.items, [])
  assert.equal(inbox.failed[0]?.repository, 'installation 1')

  const items = world({ installations: { 1: ['acme/app'] }, items: { 'acme/app': [{ labels: ['agent-develop'], number: 4 }, { labels: ['agent-develop'], number: 5 }] } })
  const partial = await listInbox({
    app: items.client(null),
    entries: async (_kind, _owner, _repo, number) => {
      if (number === 4) throw new Error('object failed')
      return [{ kind: 'error', link: issueLink, reason: 'stopped', run: 'dev-5' }]
    },
    installation: (id) => items.client(id),
    log: () => {},
  })
  assert.deepEqual(partial.failed, [{ reason: 'cannot read the develop run of #4: object failed', repository: 'acme/app' }])
  assert.deepEqual(partial.items.map((item) => item.number), [5])

  const none = world({ broken: ['/app/installations'], installations: {}, items: {} })
  const empty = await listInbox({ app: none.client(null), entries: async () => [], installation: (id) => none.client(id), log: () => {} })
  assert.equal(empty.failed[0]?.repository, 'all')
  assert.match(empty.failed[0]!.reason, /cannot list the installations of the GitHub App/)
})
