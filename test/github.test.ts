import assert from 'node:assert/strict'
import { test } from 'node:test'
import { github, GitHubError, refusedCredential } from '../src/cloudflare/github.ts'

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

test('refusedCredential is true only for a 401 or a 403 that is not a rate limit', () => {
  assert.equal(refusedCredential(new GitHubError(401, 'x')), true)
  assert.equal(refusedCredential(new GitHubError(403, 'x')), true)
  assert.equal(refusedCredential(new GitHubError(403, 'x', true)), false)
  assert.equal(refusedCredential(new GitHubError(502, 'x')), false)
  assert.equal(refusedCredential(new Error('x')), false)
})
