import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import type { WorkKind } from '../src/cloudflare/labels.ts'
import { missingAppSecrets, sweepWork, type WorkItem } from '../src/cloudflare/work-sweep.ts'

type Item = { number: number; labels: string[]; pr?: boolean }
type Setup = {
  /** The repositories (owner/repo) of each installation, by installation ID. */
  installations: Record<number, string[]>
  /** The open issues and PRs of each repository. */
  items?: Record<string, Item[]>
  /** The labeled events of each issue or PR (owner/repo#n), from the oldest: [label, actor login or null]. */
  events?: Record<string, [string, string | null][]>
  /** The objects that have a run: kind owner/repo#n. */
  runs?: string[]
  /** The path prefixes that fail with HTTP 500. */
  broken?: string[]
  /** The repositories whose prune fails. */
  brokenPrune?: string[]
  /** The items whose start fails: kind owner/repo#n. */
  brokenStart?: string[]
}

/** A GitHub stub and stub run objects. A start records a run, as the objects do. */
function world(setup: Setup) {
  const calls: string[] = []
  const starts: [WorkKind, WorkItem][] = []
  const pruned: string[] = []
  const logs: string[] = []
  const runs = new Set(setup.runs ?? [])
  const page = <T>(url: URL, all: T[]) => {
    const number = Number(url.searchParams.get('page'))
    const size = Number(url.searchParams.get('per_page'))
    return all.slice((number - 1) * size, number * size)
  }
  const gh: GitHub = {
    async json<T>(method: string, path: string): Promise<T> {
      calls.push(`${method} ${path}`)
      if (setup.broken?.some((broken) => path.startsWith(broken))) throw new GitHubError(500, `GitHub ${method} ${path} answered HTTP 500`)
      const url = new URL(path, 'https://api.github.test')
      if (url.pathname === '/app/installations') return page(url, Object.keys(setup.installations).map((id) => ({ id: Number(id) }))) as T
      if (url.pathname === '/installation/repositories') {
        const id = Number(url.searchParams.get('installation'))
        const repositories = (setup.installations[id] ?? []).map((name) => ({ name: name.split('/')[1], owner: { login: name.split('/')[0] } }))
        return { repositories: page(url, repositories), total_count: repositories.length } as T
      }
      const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname)
      if (issues) {
        assert.equal(url.searchParams.get('state'), 'open')
        const label = url.searchParams.get('labels')!
        const found = (setup.items?.[issues[1]!] ?? []).filter((item) => item.labels.includes(label))
        return page(url, found.map((item) => ({ number: item.number, ...(item.pr ? { pull_request: { url: 'x' } } : {}) }))) as T
      }
      const events = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/.exec(url.pathname)
      if (events) {
        const all = (setup.events?.[`${events[1]}#${events[2]}`] ?? []).map(([label, login]) => ({ actor: login === null ? null : { login }, event: 'labeled', label: { name: label } }))
        return page(url, [{ actor: { login: 'Maintainer' }, event: 'unlabeled', label: { name: 'agent-develop' } }, ...all]) as T
      }
      throw new Error(`stub has no route ${method} ${path}`)
    },
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  }
  /** The client of an installation adds its ID to the repository list, so that the stub answers for that installation. */
  const installation = (id: number): GitHub => ({
    ...gh,
    json: <T>(method: string, path: string) => gh.json<T>(method, path === '/installation/repositories' || path.startsWith('/installation/repositories?') ? path.replace(/^\/installation\/repositories\??/, `/installation/repositories?installation=${id}&`) : path),
  })
  const sweep = () =>
    sweepWork({
      allowed: ['Maintainer', 'Second'],
      app: gh,
      hasRun: async (kind, owner, repo, number) => runs.has(`${kind} ${owner}/${repo}#${number}`),
      installation,
      log: (line) => logs.push(line),
      prune: async (owner, repo) => {
        if (setup.brokenPrune?.includes(`${owner}/${repo}`)) throw new Error('prune failed')
        pruned.push(`${owner}/${repo}`)
      },
      start: async (kind, item) => {
        const name = `${kind} ${item.owner}/${item.repo}#${item.number}`
        if (setup.brokenStart?.includes(name)) throw new Error('start failed')
        starts.push([kind, item])
        runs.add(name)
      },
    })
  const eventReads = () => calls.filter((call) => call.includes('/events'))
  return { calls, eventReads, logs, pruned, starts, sweep }
}

const item = (number: number, by: string, repo = 'app'): WorkItem => ({ by, number, owner: 'acme', repo })

test('a labeled issue with no run starts with the labeler as by, and the branches of the repository are pruned', async () => {
  const run = world({ events: { 'acme/app#5': [['agent-develop', 'Maintainer']] }, installations: { 1: ['acme/app'] }, items: { 'acme/app': [{ labels: ['agent-develop'], number: 5 }] } })
  await run.sweep()
  assert.deepEqual(run.starts, [['develop', item(5, 'Maintainer')]])
  assert.deepEqual(run.pruned, ['acme/app'])
})

test('an issue with a run is skipped, and its events are not read', async () => {
  const run = world({
    events: { 'acme/app#5': [['agent-develop', 'Maintainer']] },
    installations: { 1: ['acme/app'] },
    items: { 'acme/app': [{ labels: ['agent-develop'], number: 5 }] },
    runs: ['develop acme/app#5'],
  })
  await run.sweep()
  assert.deepEqual(run.starts, [])
  assert.deepEqual(run.eventReads(), [])
})

test('the latest labeled event of the label decides, and a login outside ALLOWED_USERS or no actor is skipped', async () => {
  const run = world({
    events: {
      'acme/app#5': [['agent-develop', 'Maintainer'], ['agent-develop', 'stranger']],
      'acme/app#6': [['agent-develop', 'stranger'], ['agent-develop', 'maintainer'], ['agent-research', 'stranger']],
      'acme/app#7': [['agent-develop', null]],
      'acme/app#8': [['agent-research', 'Maintainer']],
    },
    installations: { 1: ['acme/app'] },
    items: { 'acme/app': [5, 6, 7, 8].map((number) => ({ labels: ['agent-develop'], number })) },
  })
  await run.sweep()
  assert.deepEqual(run.starts, [['develop', item(6, 'maintainer')]])
})

test('two sweeps start each issue or PR at most one time', async () => {
  const run = world({
    events: { 'acme/app#5': [['agent-develop', 'Maintainer']], 'acme/app#9': [['agent-review', 'Second']] },
    installations: { 1: ['acme/app'] },
    items: { 'acme/app': [{ labels: ['agent-develop'], number: 5 }, { labels: ['agent-review'], number: 9, pr: true }] },
  })
  await run.sweep()
  const reads = run.eventReads().length
  await run.sweep()
  assert.deepEqual(run.starts, [['develop', item(5, 'Maintainer')], ['review', item(9, 'Second')]])
  assert.equal(run.eventReads().length, reads)
  assert.deepEqual(run.pruned, ['acme/app', 'acme/app'])
})

test('agent-review starts a review on a PR, a label of the wrong type is skipped, and both issue labels start each kind', async () => {
  const run = world({
    events: {
      'acme/app#4': [['agent-review', 'Maintainer']],
      'acme/app#5': [['agent-develop', 'Maintainer'], ['agent-research', 'Second']],
      'acme/app#9': [['agent-review', 'Maintainer'], ['agent-develop', 'Maintainer'], ['agent-research', 'Maintainer']],
    },
    installations: { 1: ['acme/app'] },
    items: {
      'acme/app': [
        { labels: ['agent-review'], number: 4 },
        { labels: ['agent-develop', 'agent-research'], number: 5 },
        { labels: ['agent-review', 'agent-develop', 'agent-research'], number: 9, pr: true },
      ],
    },
  })
  await run.sweep()
  assert.deepEqual(run.starts, [
    ['develop', item(5, 'Maintainer')],
    ['research', item(5, 'Second')],
    ['review', item(9, 'Maintainer')],
  ])
  assert.ok(!run.eventReads().some((call) => call.includes('/issues/4/')), run.calls.join('\n'))
})

test('the sweep reads all pages of the installations, the repositories, the issues and the events', async () => {
  const installations = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [index + 1, index === 100 ? Array.from({ length: 101 }, (_, repo) => `acme/r${repo}`) : []]))
  const filler = Array.from({ length: 101 }, (): [string, string] => ['agent-research', 'stranger'])
  const run = world({
    events: { 'acme/r100#101': [...filler, ['agent-develop', 'Maintainer']] },
    installations,
    items: { 'acme/r100': Array.from({ length: 101 }, (_, index) => ({ labels: ['agent-develop'], number: index + 1 })) },
  })
  await run.sweep()
  assert.deepEqual(run.starts, [['develop', item(101, 'Maintainer', 'r100')]])
  assert.equal(run.pruned.length, 101)
  const pages = (prefix: string) => run.calls.filter((call) => call.startsWith(`GET ${prefix}`)).map((call) => new URL(call.slice(4), 'https://x').searchParams.get('page'))
  assert.deepEqual(pages('/app/installations'), ['1', '2'])
  assert.deepEqual(pages('/installation/repositories?installation=101&'), ['1', '2'])
  assert.deepEqual(pages('/repos/acme/r100/issues?state=open&labels=agent-develop'), ['1', '2'])
  assert.deepEqual(pages('/repos/acme/r100/issues/101/events'), ['1', '2'])
})

test('a failed installation, repository, item, start or prune is logged, and the sweep continues', async () => {
  const run = world({
    broken: ['/installation/repositories?installation=1&', '/repos/acme/bad/issues', '/repos/acme/app/issues/5/events'],
    brokenPrune: ['acme/app'],
    brokenStart: ['develop acme/app#7'],
    events: { 'acme/app#6': [['agent-develop', 'Maintainer']], 'acme/app#7': [['agent-develop', 'Maintainer']], 'acme/next#3': [['agent-develop', 'Maintainer']] },
    installations: { 1: ['acme/lost'], 2: ['acme/bad', 'acme/app', 'acme/next'] },
    items: { 'acme/app': [5, 6, 7].map((number) => ({ labels: ['agent-develop'], number })), 'acme/next': [{ labels: ['agent-develop'], number: 3 }] },
  })
  await run.sweep()
  assert.deepEqual(run.starts, [['develop', item(6, 'Maintainer')], ['develop', item(3, 'Maintainer', 'next')]])
  assert.deepEqual(run.pruned, ['acme/bad', 'acme/next'])
  const failures = run.logs.filter((line) => !line.includes(' started '))
  // One for installation 1, one for each label list of acme/bad, and one each for acme/app#5, acme/app#7 and the prune of acme/app.
  assert.equal(failures.length, 7, failures.join('\n'))
  assert.match(failures[0]!, /repositories of installation 1: .*HTTP 500/)
  assert.ok(failures.some((line) => /acme\/app#5: .*HTTP 500/.test(line)))
  assert.ok(failures.some((line) => /acme\/app#7: start failed/.test(line)))
  assert.ok(failures.some((line) => /branch sweep of acme\/app failed: prune failed/.test(line)))
})

test('the App secrets check names each missing secret', () => {
  assert.equal(missingAppSecrets({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem' }), null)
  assert.match(missingAppSecrets({ GITHUB_APP_ID: '1' }) ?? '', /GITHUB_APP_PRIVATE_KEY is not set/)
  assert.match(missingAppSecrets({ GITHUB_APP_PRIVATE_KEY: 'pem' }) ?? '', /GITHUB_APP_ID is not set/)
  assert.match(missingAppSecrets({ GITHUB_APP_ID: '' }) ?? '', /GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set/)
})
