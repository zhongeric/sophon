import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runLock, type Egress } from '../src/core/egress.ts'
import type { DataStore } from '../src/core/platform.ts'
import { rateLimiter, sweepEgressHandler } from '../src/core/sweep-egress.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sweepEgressServer } from '../src/node/sweep-egress.ts'
import { memoryArtifacts } from './support/artifacts.ts'

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const secret = 'archive-s3cret'

/** The most starts in any one-second window. */
const busiest = (starts: number[]) => Math.max(0, ...starts.map((start) => starts.filter((other) => other >= start && other < start + 1000).length))

test('the limiter starts at most N requests in each second, with no burst at the start', async () => {
  let now = 1_000_000
  const limit = rateLimiter(5, { now: () => now, wait: async (ms) => void (now += ms) })
  const starts: number[] = []
  for (let index = 0; index < 12; index++) {
    await limit()
    starts.push(now)
  }
  assert.equal(starts[0], 1_000_000)
  assert.equal(busiest(starts), 5)
  assert.deepEqual(starts.slice(0, 3), [1_000_000, 1_000_200, 1_000_400])
})

test('requests that wait at the same time get different slots, and a slow rate waits more than one second', async () => {
  const waits: number[] = []
  const limit = rateLimiter(3, { now: () => 0, wait: async (ms) => void waits.push(ms) })
  await Promise.all(Array.from({ length: 7 }, () => limit()))
  const starts = [0, ...waits]
  assert.equal(busiest(starts), 3)
  const slow: number[] = []
  const halfRate = rateLimiter(0.5, { now: () => 0, wait: async (ms) => void slow.push(ms) })
  await halfRate()
  await halfRate()
  assert.deepEqual(slow, [2000])
  assert.throws(() => rateLimiter(0), /not a finite number more than 0/)
})

type Call = { url: string; headers: Headers }

function setup(answer: (call: Call) => Promise<Response> = async () => new Response('row 1', { headers: { 'content-type': 'text/csv', 'set-cookie': 'x=1' } })) {
  const calls: Call[] = []
  const lines: string[] = []
  const stored = new Map<string, Uint8Array>()
  const bodies: DataStore = {
    put: async (bytes) => {
      stored.set(sha256(bytes), bytes)
      return sha256(bytes)
    },
    get: async (id) => stored.get(id) ?? null,
  }
  const artifacts = memoryArtifacts()
  let limited = 0
  const egress: Egress = { hosts: ['archive.example.org'], web_search: false, credentials: { 'archive.example.org': { header: 'x-api-key', secret: 'ARCHIVE_TOKEN' } } }
  const lock = runLock(fileLedger(join(mkdtempSync(join(tmpdir(), 'sweep-egress-')), 'state.json')), ['https://archive.example.org/holdout/'])
  const handler = sweepEgressHandler({
    egress,
    host: {
      artifacts,
      bodies,
      lock,
      secret: (name) => (name === 'ARCHIVE_TOKEN' ? secret : undefined),
      fetch: async (input, init) => {
        const call = { url: String(input), headers: new Headers(init?.headers) }
        calls.push(call)
        return answer(call)
      },
    },
    log: (line) => lines.push(line),
    limit: async () => void limited++,
  })
  return { handler, calls, lines, stored, artifacts, limited: () => limited }
}

const get = (path: string) => new Request(`http://127.0.0.1:9/${path}`)

test('a proxy path goes to the https URL with the credential header, and the body goes to the data store', async () => {
  const run = setup()
  const response = await run.handler(get('archive.example.org/data/T-1.csv?band=r&x=1'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'row 1')
  assert.equal(run.calls[0]?.url, 'https://archive.example.org/data/T-1.csv?band=r&x=1')
  assert.equal(run.calls[0]?.headers.get('x-api-key'), secret)
  assert.equal(response.headers.get('content-type'), 'text/csv')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('x-artifact-id'), sha256('row 1'))
  assert.deepEqual([...run.stored.keys()], [sha256('row 1')])
  const artifacts = await run.artifacts.list()
  assert.deepEqual(artifacts.map(({ id }) => id), [response.headers.get('x-provenance-id')])
  assert.equal(run.limited(), 1)
  assert.equal(run.lines.length, 1)
  assert.match(run.lines[0] ?? '', /^sweep fetch: egress GET https:\/\/archive\.example\.org\/data\/T-1\.csv\?band=r&x=1 200 artifact /)
})

test('a host not in the list and a locked holdout URL give 403, a bad path 400, and an upstream error 502, without the secret', async () => {
  const run = setup(async (call) => {
    if (call.url.includes('broken')) throw new Error('connect failed')
    return new Response('ok')
  })
  const cases: [string, number, RegExp][] = [
    ['evil.example.net/data', 403, /egress refused: host evil\.example\.net is not in the list/],
    ['archive.example.org/holdout/T-9', 403, /egress refused: lock: /],
    ['', 400, /the path must be \/<host>\/<path>/],
    ['archive.example.org:8080/data', 400, /the path must be/],
    ['a%20b/data', 400, /the path must be/],
    ['archive.example.org/broken', 502, /^egress: the request to archive\.example\.org failed$/],
  ]
  for (const [path, status, message] of cases) {
    const response = await run.handler(get(path))
    const body = await response.text()
    assert.equal(response.status, status, path)
    assert.match(body.trim(), message)
    assert.ok(!body.includes(secret), body)
  }
  assert.deepEqual(run.calls.map(({ url }) => url), ['https://archive.example.org/broken'])
  assert.equal(run.lines.length, cases.length)
  for (const line of run.lines) assert.ok(!line.includes(secret), line)
  assert.equal(run.stored.size, 0)
})

test('the Node server forwards a real request to the handler and does not keep the process alive', async () => {
  const seen: string[] = []
  const server = sweepEgressServer(async (request) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)
    return new Response('forwarded', { status: 201, headers: { 'x-artifact-id': 'abc' } })
  })
  try {
    const base = await server.url()
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(await server.url(), base)
    const response = await fetch(`${base}/archive.example.org/data/T-1?band=r`)
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('x-artifact-id'), 'abc')
    assert.equal(await response.text(), 'forwarded')
    assert.deepEqual(seen, ['GET /archive.example.org/data/T-1?band=r'])
  } finally {
    await server.close()
  }
})
