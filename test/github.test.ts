import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { github, GitHubError, refusedCredential, type GitHub } from '../src/cloudflare/github.ts'
import { deleteRemoteBranch } from '../src/cloudflare/branches.ts'
import { githubPulls } from '../src/cloudflare/pulls.ts'
import { githubRepo } from '../src/cloudflare/repo.ts'
import { sqliteStore } from '../src/node/platform.ts'

const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers, status })

/** A GitHub client on a fake fetch that gives the scripted answers in sequence and records each call and each wait. */
function scripted(...steps: (Response | Error)[]) {
  const calls: string[] = []
  const waits: number[] = []
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    const step = steps.shift()
    if (step === undefined) throw new Error('no scripted answer left')
    if (step instanceof Error) throw step
    return step
  }
  const client = github('token', 'https://api.test', fetcher, {
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  return { calls, client, waits }
}

test('a GET retries a 502 and gives the JSON of the next answer', async () => {
  const { calls, client, waits } = scripted(answer(502), answer(200, { number: 7 }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app/pulls/7'), { number: 7 })
  assert.deepEqual(calls, ['GET https://api.test/repos/acme/app/pulls/7', 'GET https://api.test/repos/acme/app/pulls/7'])
  assert.deepEqual(waits, [1_000])
})

test('a GET stops after 3 tries and throws the last 503', async () => {
  const { calls, client, waits } = scripted(answer(503), answer(503), answer(503), answer(200))
  await assert.rejects(client.json('GET', '/repos/acme/app'), {
    message: /^GitHub GET \/repos\/acme\/app answered HTTP 503: /,
    name: 'GitHubError',
    rateLimited: false,
    status: 503,
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(waits, [1_000, 2_000])
})

test('a GET retries a network error', async () => {
  const { calls, client } = scripted(new TypeError('fetch failed'), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 2)
})

test('a GET throws the original network error after 3 tries', async () => {
  const failure = new TypeError('fetch failed')
  const { calls, client } = scripted(failure, failure, failure)
  await assert.rejects(client.json('GET', '/repos/acme/app'), (error) => error === failure)
  assert.equal(calls.length, 3)
})

test('raw retries a 504', async () => {
  const { calls, client } = scripted(answer(504), new Response('archive', { status: 200 }))
  assert.equal(await (await client.raw('/repos/acme/app/tarball/main', 'application/vnd.github+json')).text(), 'archive')
  assert.equal(calls.length, 2)
})

test('a PATCH and a POST to the Git Data objects retry a 500', async () => {
  const patch = scripted(answer(500), answer(200, { ref: 'refs/heads/x' }))
  assert.deepEqual(await patch.client.json('PATCH', '/repos/acme/app/git/refs/heads/x', { sha: 'a' }), { ref: 'refs/heads/x' })
  assert.deepEqual(patch.calls, ['PATCH https://api.test/repos/acme/app/git/refs/heads/x', 'PATCH https://api.test/repos/acme/app/git/refs/heads/x'])
  const blob = scripted(answer(500), answer(201, { sha: 'b' }))
  assert.deepEqual(await blob.client.json('POST', '/repos/acme/app/git/blobs', { content: 'x' }), { sha: 'b' })
  assert.deepEqual(blob.calls, ['POST https://api.test/repos/acme/app/git/blobs', 'POST https://api.test/repos/acme/app/git/blobs'])
})

test('a comment POST does not retry a 502 or a network error', async () => {
  const failed = scripted(answer(502), answer(201))
  await assert.rejects(failed.client.json('POST', '/repos/acme/app/issues/7/comments', { body: 'x' }), { status: 502 })
  assert.equal(failed.calls.length, 1)
  assert.deepEqual(failed.waits, [])
  const failure = new TypeError('fetch failed')
  const lost = scripted(failure, answer(201))
  await assert.rejects(lost.client.json('POST', '/repos/acme/app/issues/7/comments', { body: 'x' }), (error) => error === failure)
  assert.equal(lost.calls.length, 1)
})

test('a comment POST on a repository with a Git Data name does not retry a 502', async () => {
  const { calls, client, waits } = scripted(answer(502), answer(201))
  await assert.rejects(client.json('POST', '/repos/git/refs/issues/7/comments', { body: 'x' }), { status: 502 })
  assert.equal(calls.length, 1)
  assert.deepEqual(waits, [])
})

test('the GraphQL POST does not retry a 502', async () => {
  const { calls, client, waits } = scripted(answer(502), answer(200, { data: {} }))
  await assert.rejects(client.graphql('query { viewer { login } }', {}), { status: 502 })
  assert.deepEqual(calls, ['POST https://api.test/graphql'])
  assert.deepEqual(waits, [])
})

test('other 4xx answers and a 403 without rate-limit headers throw at once', async () => {
  for (const status of [401, 403, 404, 422]) {
    const { calls, client, waits } = scripted(answer(status), answer(200))
    await assert.rejects(client.json('GET', '/repos/acme/app'), { name: 'GitHubError', rateLimited: false, status })
    assert.equal(calls.length, 1, `HTTP ${status}`)
    assert.deepEqual(waits, [], `HTTP ${status}`)
  }
})

test('a 501 is not retried', async () => {
  const { calls, client } = scripted(answer(501), answer(200))
  await assert.rejects(client.json('GET', '/repos/acme/app'), { status: 501 })
  assert.equal(calls.length, 1)
})

test('a 403 with retry-after waits the given seconds and then succeeds', async () => {
  const { calls, client, waits } = scripted(answer(403, {}, { 'retry-after': '5' }), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [5_000])
})

test('a 429 with x-ratelimit-remaining 0 is retried', async () => {
  const { calls, client, waits } = scripted(answer(429, {}, { 'x-ratelimit-remaining': '0' }), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [1_000])
})

test('an exhausted rate limit with a reset more than 60 seconds away throws at once', async (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  for (const status of [403, 429]) {
    const { calls, client, waits } = scripted(answer(status, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000120' }), answer(200))
    await assert.rejects(client.json('GET', '/repos/acme/app'), { rateLimited: true, status })
    assert.equal(calls.length, 1)
    assert.deepEqual(waits, [])
  }
})

test('an exhausted rate limit waits until the reset, with the backoff as the minimum', async (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  for (const [reset, wait] of [['1700000005', 5_000], ['1699999999', 1_000], ['invalid', 1_000]] as const) {
    const { calls, client, waits } = scripted(answer(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), answer(200, { ok: true }))
    assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
    assert.equal(calls.length, 2)
    assert.deepEqual(waits, [wait])
  }
})

test('retry-after takes precedence over an exhausted rate-limit reset', async (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  const { calls, client, waits } = scripted(answer(403, {}, { 'retry-after': '5', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000120' }), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [5_000])
})

test('a rate limit with retry-after 0 still waits the backoff', async () => {
  const { calls, client, waits } = scripted(answer(403, {}, { 'retry-after': '0' }), answer(429, {}, { 'retry-after': '0' }), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 3)
  assert.deepEqual(waits, [1_000, 2_000])
})

test('invalid retry-after values use the backoff', async () => {
  const { calls, client, waits } = scripted(answer(403, {}, { 'retry-after': 'invalid' }), answer(429, {}, { 'retry-after': 'Infinity' }), answer(200, { ok: true }))
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.equal(calls.length, 3)
  assert.deepEqual(waits, [1_000, 2_000])
})

test('a comment POST retries a rate limit', async () => {
  const { calls, client } = scripted(answer(403, {}, { 'retry-after': '1' }), answer(201, { id: 1 }))
  assert.deepEqual(await client.json('POST', '/repos/acme/app/issues/7/comments', { body: 'x' }), { id: 1 })
  assert.equal(calls.length, 2)
})

test('a rate-limit wait longer than 60 seconds throws at once', async () => {
  const { calls, client, waits } = scripted(answer(403, {}, { 'retry-after': '120' }), answer(200))
  await assert.rejects(client.json('GET', '/repos/acme/app'), { rateLimited: true, status: 403 })
  assert.equal(calls.length, 1)
  assert.deepEqual(waits, [])
})

test('a rate limit on all 3 tries throws a rate-limited error', async () => {
  const limited = () => answer(429, {}, { 'retry-after': '1' })
  const { calls, client } = scripted(limited(), limited(), limited(), answer(200))
  await assert.rejects(client.json('GET', '/repos/acme/app'), { rateLimited: true, status: 429 })
  assert.equal(calls.length, 3)
})

test('a token function is called before each try, so a retry uses the new token', async () => {
  const steps = [answer(502), answer(200, { ok: true })]
  const authorizations: string[] = []
  const fetcher: typeof fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
    return steps.shift() ?? answer(500)
  }
  let tokens = 0
  const client = github(async () => `token${++tokens}`, 'https://api.test', fetcher, { sleep: async () => {} })
  assert.deepEqual(await client.json('GET', '/repos/acme/app'), { ok: true })
  assert.deepEqual(authorizations, ['Bearer token1', 'Bearer token2'])
})

test('refusedCredential is true only for a 401 or a 403 that is not a rate limit', () => {
  assert.equal(refusedCredential(new GitHubError(401, 'x')), true)
  assert.equal(refusedCredential(new GitHubError(403, 'x')), true)
  assert.equal(refusedCredential(new GitHubError(403, 'x', true)), false)
  assert.equal(refusedCredential(new GitHubError(502, 'x')), false)
  assert.equal(refusedCredential(new Error('x')), false)
})

test('json gives undefined for a 204 answer without a body', async () => {
  const { calls, client } = scripted(new Response(null, { status: 204 }))
  assert.equal(await client.json('DELETE', '/repos/acme/app/git/refs/heads/x'), undefined)
  assert.deepEqual(calls, ['DELETE https://api.test/repos/acme/app/git/refs/heads/x'])
})

/** A GitHub client that gives the scripted JSON answers in sequence, throws the scripted errors, and records each call. */
function stubbed(...answers: (unknown | Error)[]) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const stub: GitHub = {
    async json<T>(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body })
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer as T
    },
    raw: async () => new Response(null),
    graphql: async () => {
      throw new Error('no GraphQL')
    },
  }
  return { calls, stub }
}

test('a PR merge sends the method and the head, a stale refusal is a result, and other refusals of GitHub throw', async () => {
  const stale = new GitHubError(409, 'GitHub PUT /repos/acme/app/pulls/7/merge answered HTTP 409: Head branch was modified')
  const refusal = new GitHubError(405, 'GitHub PUT /repos/acme/app/pulls/7/merge answered HTTP 405: Pull Request is not mergeable')
  const unread = new GitHubError(404, 'Not Found')
  const { calls, stub } = stubbed({ merged: true, sha: 'abc123', message: 'Pull Request successfully merged' }, stale, unread, refusal, unread)
  const pulls = githubPulls(stub, 'acme', 'app', 'main')
  assert.deepEqual(await pulls.merge(7, { method: 'squash', sha: 'f00d' }), { merged: true, sha: 'abc123' })
  assert.deepEqual(calls, [{ method: 'PUT', path: '/repos/acme/app/pulls/7/merge', body: { merge_method: 'squash', sha: 'f00d' } }])
  assert.deepEqual(await pulls.merge(7, { method: 'rebase', sha: 'f00d' }), { merged: false, reason: stale.message, kind: 'stale' })
  await assert.rejects(pulls.merge(7, { method: 'rebase', sha: 'f00d' }), refusal)
})

test('a refused PR merge of a resumed run returns the merge when GitHub already merged the PR at the head', async () => {
  const refusal = new GitHubError(405, 'GitHub PUT /repos/acme/app/pulls/7/merge answered HTTP 405: Pull Request is not mergeable')
  const pull = (sha: string) => ({ merged: true, merge_commit_sha: 'abc123', head: { sha } })
  const { calls, stub } = stubbed(refusal, pull('f00d'), refusal, pull('beef'))
  const pulls = githubPulls(stub, 'acme', 'app', 'main')
  assert.deepEqual(await pulls.merge(7, { method: 'squash', sha: 'f00d' }), { merged: true, sha: 'abc123' })
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['PUT /repos/acme/app/pulls/7/merge', 'GET /repos/acme/app/pulls/7'])
  // A PR that merged at another head is not the merge of this run: the refusal stays.
  await assert.rejects(pulls.merge(7, { method: 'squash', sha: 'f00d' }), refusal)
})

test('a rerun of the failed jobs posts to the run, and a 403 that is not a rate limit is a refusal result', async () => {
  const refused = new GitHubError(403, 'GitHub POST /repos/acme/app/actions/runs/12/rerun-failed-jobs answered HTTP 403: Resource not accessible by integration')
  const limited = new GitHubError(403, 'API rate limit exceeded', true)
  const missing = new GitHubError(404, 'Not Found')
  const { calls, stub } = stubbed({}, refused, limited, missing)
  const pulls = githubPulls(stub, 'acme', 'app', 'main')
  assert.deepEqual(await pulls.rerunFailedJobs(12), { started: true })
  assert.deepEqual(calls, [{ method: 'POST', path: '/repos/acme/app/actions/runs/12/rerun-failed-jobs', body: undefined }])
  // The refusal is a result, so it never reaches the stop for a refused credential.
  assert.deepEqual(await pulls.rerunFailedJobs(12), { started: false, reason: refused.message })
  await assert.rejects(pulls.rerunFailedJobs(12), limited)
  await assert.rejects(pulls.rerunFailedJobs(12), missing)
})

test('the CI of a commit gives the attempt of each Actions run, and no attempt for a commit status', async () => {
  const created_at = '2026-11-01T00:00:00Z'
  const run = { id: 7, workflow_id: 1, event: 'pull_request', name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/app/actions/runs/7', created_at, run_attempt: 2 }
  const status = { context: 'deploy', state: 'failure', target_url: null, created_at }
  const { calls, stub } = stubbed({ total_count: 1, workflow_runs: [run] }, { statuses: [status] })
  const jobs = await githubPulls(stub, 'acme', 'app', 'main').ci('f00d')
  assert.deepEqual(calls.map((call) => call.path), ['/repos/acme/app/actions/runs?head_sha=f00d&per_page=100&page=1', '/repos/acme/app/commits/f00d/status'])
  assert.deepEqual(
    jobs.map(({ name, run, attempt }) => ({ name, run, attempt })),
    [
      { name: 'CI (pull_request)', run: 7, attempt: 2 },
      { name: 'deploy', run: null, attempt: undefined },
    ],
  )
})

test('a branch delete accepts a ref that is not there, but not a refused delete', async () => {
  const ref = '/repos/acme/app/git/refs/heads/factory/dev-x'
  const missing = stubbed(new GitHubError(422, 'Reference does not exist'), new GitHubError(404, 'Not Found'))
  await deleteRemoteBranch(missing.stub, '/repos/acme/app', 'factory/dev-x')
  assert.deepEqual(
    missing.calls.map((call) => `${call.method} ${call.path}`),
    [`DELETE ${ref}`, 'GET /repos/acme/app/git/ref/heads/factory/dev-x'],
  )
  const refusal = new GitHubError(422, 'Cannot delete this protected branch')
  const protectedRef = stubbed(refusal, { ref: 'refs/heads/factory/dev-x' })
  await assert.rejects(deleteRemoteBranch(protectedRef.stub, '/repos/acme/app', 'factory/dev-x'), refusal)
  const gone = stubbed(new GitHubError(404, 'Not Found'))
  await deleteRemoteBranch(gone.stub, '/repos/acme/app', 'factory/dev-x')
  assert.deepEqual(gone.calls.map((call) => call.method), ['DELETE'])
})

/** The repository of a review run of PR 7 on the stubbed GitHub client, with its fix branch factory/pr-7-x. */
function stubbedRepo(stub: GitHub) {
  const entries = new Map<string, unknown>()
  const ledger: Ledger = { get: <T>(key: string) => entries.get(key) as T | undefined, put: (key, value) => void entries.set(key, value) }
  const { sql } = sqliteStore(':memory:', join(mkdtempSync(join(tmpdir(), 'factory-github-')), 'agents'))
  return githubRepo({ branch: 'factory/pr-7-x', gh: stub, ledger, log: () => {}, pull: { owner: 'acme', repo: 'app', pr: 7 }, runId: 'pr-7-x', sql })
}

test('the PR state of a GitHub repo is merged for a merge time, closed for a closed PR, else open', async () => {
  const { calls, stub } = stubbed({ state: 'open', merged_at: null }, { state: 'closed', merged_at: '2026-11-16T12:00:00Z' }, { state: 'closed', merged_at: null })
  const repo = stubbedRepo(stub)
  assert.deepEqual([await repo.pullState(7), await repo.pullState(7), await repo.pullState(7)], ['open', 'merged', 'closed'])
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), Array(3).fill('GET /repos/acme/app/pulls/7'))
})

test('a GitHub repo deletes its fix branch on GitHub, accepts an absent branch, and its release does nothing', async () => {
  const ref = 'DELETE /repos/acme/app/git/refs/heads/factory/pr-7-x'
  const deleted = stubbed(undefined)
  await stubbedRepo(deleted.stub).deleteBranch()
  assert.deepEqual(deleted.calls.map((call) => `${call.method} ${call.path}`), [ref])
  const absent = stubbed(new GitHubError(422, 'Reference does not exist'), new GitHubError(404, 'Not Found'))
  await stubbedRepo(absent.stub).deleteBranch()
  assert.deepEqual(absent.calls.map((call) => `${call.method} ${call.path}`), [ref, 'GET /repos/acme/app/git/ref/heads/factory/pr-7-x'])
  const released = stubbed()
  await stubbedRepo(released.stub).release()
  assert.deepEqual(released.calls, [])
})
