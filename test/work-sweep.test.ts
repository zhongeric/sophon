import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { GitHubError, type GitHub } from '../src/cloudflare/github.ts'
import type { WorkKind } from '../src/cloudflare/labels.ts'
import { sweepWork, type WorkItem } from '../src/cloudflare/work-sweep.ts'
import { fixtureRepo, scriptFor } from './support/fixture.ts'
import { mockServices } from './support/mock-services.ts'
import { startWorker, until } from './support/wrangler.ts'

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
  const clients = new Set<GitHub>()
  const installation = (id: number): GitHub => {
    const client: GitHub = {
      ...gh,
      json: <T>(method: string, path: string) => gh.json<T>(method, path === '/installation/repositories' || path.startsWith('/installation/repositories?') ? path.replace(/^\/installation\/repositories\??/, `/installation/repositories?installation=${id}&`) : path),
    }
    clients.add(client)
    return client
  }
  const sweep = () =>
    sweepWork({
      allowed: ['Maintainer', 'Second'],
      app: gh,
      hasRun: async (kind, owner, repo, number) => runs.has(`${kind} ${owner}/${repo}#${number}`),
      installation,
      log: (line) => logs.push(line),
      prune: async (owner, repo, client) => {
        // The prune uses the installation client of the sweep, and gets no new access.
        assert.ok(clients.has(client))
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

test('an incorrect event fails only its item instead of authorizing from an older labeler', async () => {
  const labeled = (login: unknown) => ({ actor: { login }, event: 'labeled', label: { name: 'agent-develop' } })
  const answers: Record<string, unknown> = {
    '/app/installations': [{ id: 1 }, { id: '2' }, null],
    '/installation/repositories': { repositories: [{ name: 'lost' }, { name: 'app', owner: { login: 'acme' } }] },
    '/repos/acme/app/issues?state=open&labels=agent-develop': [{ number: 5 }, { number: 6 }, { number: 7 }, { number: 8 }, { title: 'no number' }],
    '/repos/acme/app/issues/5/events': [labeled(7), labeled('Maintainer')],
    '/repos/acme/app/issues/6/events': { message: 'not a list' },
    '/repos/acme/app/issues/7/events': [labeled('Maintainer'), labeled(7)],
    '/repos/acme/app/issues/8/events': [labeled('Maintainer')],
  }
  const gh: GitHub = {
    json: async <T>(_method: string, path: string) => (answers[path.replace(/[?&]per_page=\d+&page=\d+$/, '')] ?? []) as T,
    raw: () => Promise.reject(new Error('no raw calls')),
    graphql: () => Promise.reject(new Error('no GraphQL calls')),
  }
  const starts: [WorkKind, WorkItem][] = []
  const pruned: string[] = []
  const logs: string[] = []
  await sweepWork({
    allowed: ['Maintainer'],
    app: gh,
    hasRun: async () => false,
    installation: () => gh,
    log: (line) => logs.push(line),
    prune: async (owner, repo) => pruned.push(`${owner}/${repo}`),
    start: async (kind, found) => starts.push([kind, found]),
  })
  assert.deepEqual(starts, [['develop', item(8, 'Maintainer')]])
  assert.deepEqual(pruned, ['acme/app'])
  const skipped = logs.filter((line) => line.includes('incorrect shape'))
  // Two installations, one repository, one issue and two events.
  assert.equal(skipped.length, 6, logs.join('\n'))
  for (const number of [5, 7]) {
    assert.ok(logs.some((line) => line.includes(`acme/app#${number}: GitHub issue event has an incorrect shape`)), logs.join('\n'))
  }
  assert.ok(logs.some((line) => /acme\/app#6: GitHub GET \/repos\/acme\/app\/issues\/6\/events gave no list/.test(line)), logs.join('\n'))
})

/** The mock services for the cron tests, with the repository acme/app and its issue 5. */
const cronMock = (installed: boolean) =>
  mockServices(fixtureRepo(), { app: { installed, slug: 'sophon-factory' }, botLogin: 'factory-bot', issues: { 5: { body: 'Add sub.', title: 'Add sub' } }, name: 'app', owner: 'acme', script: scriptFor({ tests: false }) })
const cronVars = (github: string, models: string) => ({
  ADMIN_TOKEN: 'admin',
  ALLOWED_USERS: 'Maintainer',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_URL: `${models}/v1/messages`,
  GITHUB_API_URL: github,
  GITHUB_TOKEN: 'github-token',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  OPENAI_API_KEY: 'openai-key',
  OPENAI_URL: `${models}/v1`,
})
const cron = (url: string) => fetch(`${url}/cdn-cgi/handler/scheduled`)

test('on Cloudflare, the cron without the App secrets sends no request and logs the missing secrets one time', { timeout: 120_000 }, async () => {
  const mock = await cronMock(false)
  const worker = await startWorker(cronVars(mock.url, mock.url)).catch(async (error: unknown) => {
    await mock.close()
    throw error
  })
  const line = 'the work sweep does nothing: GITHUB_APP_ID is not set'
  const count = () => worker.output().split(line).length - 1
  const describe = () => `requests: ${mock.state.requests.join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  try {
    assert.equal((await cron(worker.url)).status, 200, describe())
    assert.equal((await cron(worker.url)).status, 200, describe())
    await until(() => (count() > 0 ? true : undefined), 30_000, describe)
    // The output of the second tick has time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(count(), 1, describe())
    assert.deepEqual(mock.state.requests, [])
  } finally {
    await worker.stop()
    await mock.close()
  }
})

async function checkCronStart(race: boolean) {
  const mock = await cronMock(true)
  // The mock has no routes for the lists of the sweep, so this proxy answers them and sends the rest to the mock.
  const routes: string[] = []
  let eventsRequested = false
  let releaseEvents: (() => void) | undefined
  const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve })
  const proxy = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    routes.push(`${request.method} ${url.pathname}${url.search}`)
    const reply = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (request.method === 'GET') {
      const page = url.searchParams.get('page') ?? '1'
      if (url.pathname === '/app/installations') return reply(page === '1' ? [{ id: 42 }] : [])
      if (url.pathname === '/installation/repositories') return reply({ repositories: page === '1' ? [{ name: 'app', owner: { login: 'acme' } }] : [], total_count: 1 })
      if (url.pathname === '/repos/acme/app/issues') return reply(page === '1' && url.searchParams.get('labels') === 'agent-develop' ? [{ number: 5 }] : [])
      if (url.pathname === '/repos/acme/app/issues/5/events') {
        eventsRequested = true
        if (race) await eventsReleased
        return reply(page === '1' ? [{ actor: { login: 'Maintainer' }, event: 'labeled', label: { name: 'agent-develop' } }] : [])
      }
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => name !== 'host' && name !== 'content-length' && typeof value === 'string')) as Record<string, string>
    const forwarded = await fetch(`${mock.url}${request.url}`, { body: chunks.length > 0 ? Buffer.concat(chunks) : undefined, headers, method: request.method })
    response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/octet-stream' }).end(Buffer.from(await forwarded.arrayBuffer()))
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const github = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const closeAll = async () => {
    proxy.closeAllConnections()
    await new Promise((resolve) => proxy.close(resolve))
    await mock.close()
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
  const worker = await startWorker({ ...cronVars(github, mock.url), GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey }).catch(async (error: unknown) => {
    await closeAll()
    throw error
  })
  const describe = () => `routes: ${routes.join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  const headers = { authorization: 'Bearer admin' }
  const status = async () => (await (await fetch(`${worker.url}/runs/acme/app/5`, { headers })).json()) as { runs: { run: string; state: string; note: string }[] }
  const swept = cron(worker.url)
  try {
    let stopped: Awaited<ReturnType<typeof status>> | undefined
    if (race) {
      // The events request comes after hasRun. Hold its response until an admin run stops.
      await until(() => eventsRequested ? true : undefined, 30_000, describe)
      assert.equal((await fetch(`${worker.url}/develop/acme/app/5`, { headers, method: 'POST' })).status, 202, describe())
      stopped = await until(async () => {
        const current = await status()
        return current.runs[0]?.state === 'error' ? current : undefined
      }, 60_000, describe)
      assert.equal(stopped.runs.length, 1, describe())
      assert.match(stopped.runs[0]?.note ?? '', /this Worker has no container for builds/, describe())
      // A new start must have a different timestamp, so a duplicate key cannot hide a second run.
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      releaseEvents?.()
    }
    assert.equal((await swept).status, 200, describe())
    const current = await status()
    assert.equal(current.runs.length, 1, describe())
    if (race) assert.deepEqual(current.runs, stopped?.runs, describe())
    assert.ok(routes.some((route) => route.startsWith('GET /repos/acme/app/git/matching-refs/heads/factory/')), describe())
    assert.ok(!worker.output().includes('the work sweep does nothing'), describe())
  } finally {
    releaseEvents?.()
    await swept.catch(() => undefined)
    await worker.stop()
    await closeAll()
  }
}

test('on Cloudflare, the cron with the App secrets starts a labeled issue with no run and sweeps the branches', { timeout: 120_000 }, () => checkCronStart(false))

test('on Cloudflare, the cron starts no second run when an admin run stops after hasRun', { timeout: 120_000 }, () => checkCronStart(true))
