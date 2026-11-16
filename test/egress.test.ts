import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactSizeLimit } from '../src/core/artifacts.ts'
import { checkEgress, egressFetch, runLock, type Egress, type EgressHost, type RunLock } from '../src/core/egress.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { memoryArtifacts } from './support/artifacts.ts'

type Call = { url: string; method: string; headers: Headers; body: Uint8Array | null; redirect: string | undefined }

const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const secretValue = 's3cret-value'
const base: Egress = { hosts: ['api.example.com', 'files.example.com'], web_search: false }
const ledgerPath = () => join(mkdtempSync(join(tmpdir(), 'factory-egress-')), 'state.json')

/** An egress over a scripted fetch that records each call. The default answer is 200 with the text "ok". */
function setup(options: { egress?: Partial<Egress>; answer?: (call: Call, index: number) => Response; lock?: RunLock; secret?: string } = {}) {
  const calls: Call[] = []
  const lines: string[] = []
  const artifacts = memoryArtifacts()
  const answer = options.answer ?? (() => new Response('ok', { headers: { 'content-type': 'text/plain' } }))
  const scripted = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : null
    const call = { url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body, redirect: init?.redirect }
    calls.push(call)
    return answer(call, calls.length - 1)
  }
  const host: EgressHost = {
    artifacts,
    secret: (name) => (name === 'ARCHIVE_KEY' ? (options.secret ?? secretValue) : undefined),
    fetch: scripted,
    ...(options.lock ? { lock: options.lock } : {}),
  }
  const egress = egressFetch('researcher', { ...base, ...options.egress }, host, (line) => lines.push(line))
  return { egress, calls, lines, artifacts, host }
}

async function refuses(promise: Promise<Response>, reason: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, /^egress refused: /)
    assert.match(error.message, reason)
    return true
  })
}

/** Refuses each URL without a call of the underlying fetch, and stores nothing. */
async function refusesAll(urls: string[], reason: RegExp, egress: Partial<Egress> = {}): Promise<void> {
  const run = setup({ egress })
  for (const url of urls) await refuses(run.egress(url), reason)
  assert.equal(run.calls.length, 0)
  assert.deepEqual(await run.artifacts.list(), [])
  assert.equal(run.lines.length, urls.length)
  for (const line of run.lines) assert.match(line, /^researcher: egress GET .* egress refused: /)
}

const redirect = (status: number, location: string) => new Response('moved', { status, headers: { location } })

test('an allowed GET goes out with manual redirects, and the agent gets the body and the artifact ID', async () => {
  const run = setup()
  const response = await run.egress('https://api.example.com/papers?q=vault#top')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0]?.url, 'https://api.example.com/papers?q=vault')
  assert.equal(run.calls[0]?.method, 'GET')
  assert.equal(run.calls[0]?.redirect, 'manual')
  const id = response.headers.get('x-artifact-id')
  assert.equal(id, sha256('ok'))
  const provenance = response.headers.get('x-provenance-id')
  assert.ok(provenance)
  assert.notEqual(provenance, id)
  const listed = await run.artifacts.list()
  assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set([id, provenance]))
  const meta = await run.artifacts.meta(id ?? '')
  assert.deepEqual(meta?.source, { url: 'https://api.example.com/papers?q=vault', method: 'GET' })
  assert.equal(meta?.media_type, 'text/plain')
  assert.deepEqual(meta?.labels, { body_sha256: emptySha, status: '200' })
  assert.deepEqual((await run.artifacts.meta(provenance))?.source, { command: 'egress provenance' })
  assert.deepEqual(run.lines, [`researcher: egress GET https://api.example.com/papers?q=vault 200 artifact ${id} provenance ${provenance}`])
})

test('a host that is not in the list is refused', async () => {
  await refusesAll(['https://evil.example.net/', 'https://example.com/'], /host .* is not in the list/)
})

test('a subdomain of a listed host is refused, and case and a trailing dot still match', async () => {
  await refusesAll(['https://sub.api.example.com/', 'https://xapi.example.com/'], /host .* is not in the list/)
  const run = setup()
  assert.equal((await run.egress('https://API.Example.com./a')).status, 200)
  assert.equal(run.calls.length, 1)
})

test('a scheme other than https is refused', async () => {
  await refusesAll(['http://api.example.com/', 'ftp://api.example.com/', 'data:text/plain,hi'], /scheme .* is not https/)
})

test('a port other than 443 is refused, and the explicit default port is accepted', async () => {
  await refusesAll(['https://api.example.com:8443/', 'https://api.example.com:80/'], /port \d+ is not 443/)
  const run = setup()
  assert.equal((await run.egress('https://api.example.com:443/')).status, 200)
})

test('user info in the URL is refused', async () => {
  await refusesAll(['https://user:pass@api.example.com/', 'https://user@api.example.com/'], /user info/)
})

test('localhost names and private, loopback, link-local and unspecified literals are refused, also when the list has them', async () => {
  const urls = [
    'https://localhost/',
    'https://a.localhost/',
    'https://0.1.2.3/',
    'https://10.0.0.1/',
    'https://100.64.0.1/',
    'https://100.127.255.254/',
    'https://127.0.0.1/',
    'https://0x7f.1/',
    'https://169.254.169.254/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://255.255.255.255/',
    'https://[::]/',
    'https://[::1]/',
    'https://[fc00::1]/',
    'https://[fdff::1]/',
    'https://[fe80::1]/',
    'https://[febf::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:a9fe:a9fe]/',
    'https://[::ffff:192.168.0.1]/',
  ]
  const hosts = urls.map((url) => new URL(url).hostname)
  await refusesAll(urls, /address .* is private or local/, { hosts })
  // The neighbors of the refused ranges pass when the list has them.
  const allowed = ['https://11.0.0.1/', 'https://100.128.0.1/', 'https://172.32.0.1/', 'https://[2001:db8::1]/', 'https://[::ffff:8.8.8.8]/']
  const run = setup({ egress: { hosts: allowed.map((url) => new URL(url).hostname) } })
  for (const url of allowed) assert.equal((await run.egress(url)).status, 200, url)
  assert.equal(run.calls.length, allowed.length)
})

test('a redirect to an unlisted host is refused, and nothing is stored', async () => {
  const run = setup({ answer: () => redirect(302, 'https://evil.example.net/x') })
  await refuses(run.egress('https://api.example.com/a'), /redirect to https:\/\/evil\.example\.net\/x: host evil\.example\.net is not in the list/)
  assert.equal(run.calls.length, 1)
  assert.deepEqual(await run.artifacts.list(), [])
  assert.match(run.lines[0] ?? '', /^researcher: egress GET https:\/\/api\.example\.com\/a egress refused: redirect/)
})

test('a redirect to a refused address or scheme is refused', async () => {
  for (const location of ['https://127.0.0.1/', 'http://files.example.com/', 'https://files.example.com:8443/']) {
    const run = setup({ answer: () => redirect(301, location) })
    await refuses(run.egress('https://api.example.com/a'), /redirect to /)
    assert.equal(run.calls.length, 1)
  }
})

test('five redirects are followed, and a sixth is refused', async () => {
  const chain = (redirects: number) => (call: Call, index: number) =>
    index < redirects ? redirect(302, `/hop/${index + 1}`) : new Response(`end of ${call.url}`)
  const five = setup({ answer: chain(5) })
  const response = await five.egress('https://api.example.com/hop/0')
  assert.equal(await response.text(), 'end of https://api.example.com/hop/5')
  assert.equal(five.calls.length, 6)
  // The bodies of the redirects are not stored.
  const listed = await five.artifacts.list()
  assert.equal(listed.length, 2)
  const meta = await five.artifacts.meta(response.headers.get('x-artifact-id') ?? '')
  assert.deepEqual(meta?.source, { url: 'https://api.example.com/hop/5', method: 'GET' })
  assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set([response.headers.get('x-artifact-id'), response.headers.get('x-provenance-id')]))

  const six = setup({ answer: chain(6) })
  await refuses(six.egress('https://api.example.com/hop/0'), /redirect: more than 5 hops/)
  assert.equal(six.calls.length, 6)
  assert.deepEqual(await six.artifacts.list(), [])
})

test('303, and 301 or 302 for a POST, continue as GET without a body. 307 and 308 keep the method and the body', async () => {
  const json = '{"q":"vault"}'
  for (const [status, method] of [[303, 'GET'], [301, 'GET'], [302, 'GET'], [307, 'POST'], [308, 'POST']] as const) {
    const run = setup({ answer: (_call, index) => (index === 0 ? redirect(status, 'https://files.example.com/b') : new Response('done')) })
    const response = await run.egress('https://api.example.com/a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json })
    assert.equal(response.status, 200)
    const hop = run.calls[1]
    assert.equal(hop?.method, method, String(status))
    assert.equal(hop?.url, 'https://files.example.com/b')
    if (method === 'GET') {
      assert.equal(hop?.body, null)
      assert.equal(hop?.headers.get('content-type'), null)
    } else {
      assert.deepEqual(hop?.body, new TextEncoder().encode(json))
    }
    const meta = await run.artifacts.meta(response.headers.get('x-artifact-id') ?? '')
    assert.deepEqual(meta?.source, { url: 'https://files.example.com/b', method })
    assert.equal(meta?.labels.body_sha256, method === 'GET' ? emptySha : sha256(json))
  }
})

test('methods other than GET and POST, and a GET with a body, are refused', async () => {
  const run = setup()
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) await refuses(run.egress('https://api.example.com/a', { method }), /method/)
  await refuses(run.egress('https://api.example.com/a', { method: 'GET', body: 'x' }), /egress refused: the request is not valid/)
  await refuses(run.egress('https://api.example.com/a', { body: 'x' }), /egress refused: the request is not valid/)
  assert.equal(run.calls.length, 0)
  assert.deepEqual(await run.artifacts.list(), [])
})

test('the host header and the method-override headers of the agent do not reach the server', async () => {
  const run = setup()
  const headers = { host: 'files.example.com', 'x-http-method-override': 'DELETE', 'x-http-method': 'DELETE', 'x-method-override': 'DELETE', accept: 'text/plain' }
  await run.egress('https://api.example.com/a', { headers })
  await run.egress('https://api.example.com/b', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(run.calls.length, 2)
  for (const call of run.calls) {
    for (const name of ['host', 'x-http-method-override', 'x-http-method', 'x-method-override']) assert.equal(call.headers.get(name), null, name)
    assert.equal(call.headers.get('accept'), 'text/plain')
  }
})

test('a POST body other than form or JSON is refused', async () => {
  const run = setup()
  const form = new FormData()
  form.set('q', 'vault')
  await refuses(run.egress('https://api.example.com/a', { method: 'POST', body: 'plain' }), /body type "text\/plain"/)
  await refuses(run.egress('https://api.example.com/a', { method: 'POST', body: form }), /body type "multipart\/form-data"/)
  await refuses(run.egress('https://api.example.com/a', { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<q/>' }), /body type/)
  await refuses(run.egress('https://api.example.com/a', { method: 'POST' }), /body type ""/)
  assert.equal(run.calls.length, 0)
})

test('a POST with a form or a JSON body goes out, and the label has the hash of the body', async () => {
  const run = setup()
  const form = await run.egress('https://api.example.com/a', { method: 'POST', body: new URLSearchParams({ q: 'vault' }) })
  const json = await run.egress('https://api.example.com/b', { method: 'post', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}' })
  assert.deepEqual(run.calls.map((call) => call.method), ['POST', 'POST'])
  assert.deepEqual(run.calls[0]?.body, new TextEncoder().encode('q=vault'))
  // Both bodies are "ok", so the store keeps the first meta for the one body artifact.
  const id = form.headers.get('x-artifact-id') ?? ''
  assert.equal(json.headers.get('x-artifact-id'), id)
  assert.notEqual(form.headers.get('x-provenance-id'), id)
  const meta = await run.artifacts.meta(id)
  assert.deepEqual(meta?.labels, { body_sha256: sha256('q=vault'), status: '200' })
  assert.deepEqual(meta?.source, { url: 'https://api.example.com/a', method: 'POST' })
  // The second request gets a provenance record of its own.
  const record = json.headers.get('x-provenance-id') ?? ''
  assert.notEqual(record, id)
  const recordMeta = await run.artifacts.meta(record)
  assert.deepEqual(recordMeta?.source, { command: 'egress provenance' })
  assert.deepEqual(recordMeta?.labels, { body_sha256: sha256('{}'), status: '200', body: id })
  assert.equal(recordMeta?.media_type, 'application/json')
  const { nonce, ...fields } = JSON.parse(new TextDecoder().decode((await run.artifacts.get(record)) ?? new Uint8Array()))
  assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(typeof recordMeta?.created, 'number')
  assert.deepEqual(fields, { body: id, url: 'https://api.example.com/b', method: 'POST', body_sha256: sha256('{}'), status: '200' })
  assert.equal(run.lines[1], `researcher: egress POST https://api.example.com/b 200 artifact ${id} provenance ${record}`)
})

test('concurrent identical responses get unique provenance records, also with an existing body and a fixed clock', async (t) => {
  const now = 1_700_000_000_000
  t.mock.method(Date, 'now', () => now)
  const run = setup()
  const url = 'https://api.example.com/a'
  const first = await Promise.all([run.egress(url), run.egress(url)])
  const repeated = await Promise.all([run.egress(url), run.egress(url)])
  const responses = [...first, ...repeated]
  const records = responses.map((response) => response.headers.get('x-provenance-id'))
  assert.equal(new Set(records).size, 4)
  const nonces = new Set<string>()
  for (const response of responses) {
    const id = response.headers.get('x-artifact-id')
    assert.equal(id, sha256('ok'))
    assert.equal(await response.text(), 'ok')
    const provenance = response.headers.get('x-provenance-id')
    assert.ok(provenance)
    assert.notEqual(provenance, id)
    const bytes = await run.artifacts.get(provenance)
    assert.ok(bytes)
    const { nonce, ...fields } = JSON.parse(new TextDecoder().decode(bytes))
    assert.equal(typeof nonce, 'string')
    nonces.add(nonce)
    assert.deepEqual(fields, { body: id, url, method: 'GET', body_sha256: emptySha, status: '200' })
    const meta = await run.artifacts.meta(provenance)
    assert.deepEqual(meta?.source, { command: 'egress provenance' })
    assert.equal(meta?.media_type, 'application/json')
    assert.equal(meta?.created, now)
    assert.deepEqual(meta?.labels, { body_sha256: emptySha, status: '200', body: id })
  }
  assert.equal(nonces.size, 4)
  assert.equal((await run.artifacts.list()).length, 5)
  assert.equal(run.lines.length, 4)
})

test('a Content-Length over the cap is refused before the read', async () => {
  let pulled = false
  // With a high-water mark of 0, the stream pulls only for a read.
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true
      },
    },
    { highWaterMark: 0 },
  )
  const run = setup({ egress: { max_bytes: 10 }, answer: () => new Response(body, { headers: { 'content-length': '11' } }) })
  await refuses(run.egress('https://api.example.com/a'), /size: the content-length 11 is over the cap of 10 bytes/)
  assert.equal(pulled, false)
  assert.deepEqual(await run.artifacts.list(), [])
})

test('a stream over the cap is cancelled and refused, and nothing is stored', async () => {
  let cancelled = false
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 4
      controller.enqueue(new Uint8Array(4).fill(1))
    },
    cancel() {
      cancelled = true
    },
  })
  const run = setup({ egress: { max_bytes: 10 }, answer: () => new Response(body) })
  await refuses(run.egress('https://api.example.com/a'), /size: the body is over the cap of 10 bytes/)
  assert.ok(cancelled)
  assert.ok(sent <= 16, String(sent))
  assert.deepEqual(await run.artifacts.list(), [])
})

test('a body of exactly the cap is accepted', async () => {
  const bytes = new Uint8Array(10).fill(7)
  const run = setup({ egress: { max_bytes: 10 }, answer: () => new Response(bytes, { headers: { 'content-length': '10' } }) })
  const response = await run.egress('https://api.example.com/a')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  assert.equal(response.headers.get('x-artifact-id'), sha256(bytes))
})

test('without max_bytes, the cap is 8 MiB: a body of 8 MiB is accepted, and a stream of one more byte is refused', async () => {
  const cap = 8 * 1024 * 1024
  const full = setup({ answer: () => new Response(new Uint8Array(cap)) })
  const response = await full.egress('https://api.example.com/a')
  assert.equal((await response.arrayBuffer()).byteLength, cap)
  assert.equal((await full.artifacts.list()).length, 2)

  // The stream has no content-length, so the egress counts the bytes.
  const chunks = [new Uint8Array(cap), new Uint8Array(1)]
  const over = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
  const run = setup({ answer: () => new Response(over) })
  await refuses(run.egress('https://api.example.com/a'), /size: the body is over the cap of 8388608 bytes/)
  assert.deepEqual(await run.artifacts.list(), [])
})

test('the run lock refuses a matching first URL', async () => {
  const lock = runLock(fileLedger(ledgerPath()), ['https://api.example.com/holdout'])
  const run = setup({ lock })
  await refuses(run.egress('https://api.example.com/holdout/paper.pdf'), /lock: https:\/\/api\.example\.com\/holdout\/paper\.pdf is locked/)
  await refuses(run.egress('https://API.example.com/holdout#x'), /lock/)
  assert.equal(run.calls.length, 0)
  assert.equal((await run.egress('https://api.example.com/other')).status, 200)
  assert.equal(run.calls.length, 1)
})

test('the run lock refuses a matching redirect hop', async () => {
  const lock = runLock(fileLedger(ledgerPath()), ['https://files.example.com/holdout/'])
  const run = setup({ lock, answer: () => redirect(302, 'https://files.example.com/holdout/a') })
  await refuses(run.egress('https://api.example.com/a'), /redirect to https:\/\/files\.example\.com\/holdout\/a: lock/)
  assert.equal(run.calls.length, 1)
  assert.deepEqual(await run.artifacts.list(), [])
})

test('the run lock refuses a trailing dot on the host and escaped letters in the path and query, on the first URL and on a redirect hop', async () => {
  const lock = runLock(fileLedger(ledgerPath()), ['https://api.example.com/holdout', 'https://api.example.com/papers?range=holdout'])
  const spellings = [
    'https://api.example.com./holdout/x',
    'https://api.example.com/%68oldout/x',
    'https://api.example.com/%68%6F%6cdout/x',
    'https://api.example.com/papers?range=%68oldout',
  ]
  for (const spelling of spellings) assert.ok(lock.locked(spelling), spelling)
  const run = setup({ lock })
  for (const spelling of spellings) await refuses(run.egress(spelling), /lock: .* is locked/)
  assert.equal(run.calls.length, 0)
  for (const spelling of spellings) {
    const hop = setup({ lock, answer: () => redirect(302, spelling) })
    await refuses(hop.egress('https://files.example.com/a'), /redirect to .*: lock: .* is locked/)
    assert.equal(hop.calls.length, 1)
    assert.deepEqual(await hop.artifacts.list(), [])
  }
  // An escape of a reserved character is not decoded, so the URL does not match.
  assert.ok(!lock.locked('https://api.example.com/hold%2Fout/x'))
})

test('an unlock opens the pattern, and a new lock over the same ledger keeps it', async () => {
  const path = ledgerPath()
  const patterns = ['https://api.example.com/holdout', 'https://files.example.com/secret']
  const lock = runLock(fileLedger(path), patterns)
  assert.deepEqual(lock.pending(), patterns)
  assert.ok(lock.locked('https://api.example.com/holdout/x'))
  assert.throws(() => lock.unlock('https://api.example.com/other'), /not a lock pattern/)
  lock.unlock('https://API.example.com/holdout#part')
  assert.ok(!lock.locked('https://api.example.com/holdout/x'))
  assert.deepEqual(lock.pending(), ['https://files.example.com/secret'])

  // A resumed run reads the ledger from the disk.
  const resumed = runLock(fileLedger(path), patterns)
  assert.deepEqual(resumed.pending(), ['https://files.example.com/secret'])
  assert.ok(!resumed.locked('https://api.example.com/holdout/x'))
  assert.ok(resumed.locked('https://files.example.com/secret/y'))
  const run = setup({ lock: resumed })
  assert.equal((await run.egress('https://api.example.com/holdout/x')).status, 200)
})

const keyed: Partial<Egress> = { credentials: { 'api.example.com': { header: 'x-api-key', secret: 'ARCHIVE_KEY' } } }

test('the credential header is added for its host, and it replaces the value of the agent', async () => {
  const run = setup({ egress: keyed })
  await run.egress('https://api.example.com/a', { headers: { 'X-Api-Key': 'from-agent', accept: 'text/plain' } })
  await run.egress('https://files.example.com/a', { headers: { 'x-api-key': 'from-agent' } })
  assert.equal(run.calls[0]?.headers.get('x-api-key'), secretValue)
  assert.equal(run.calls[0]?.headers.get('accept'), 'text/plain')
  assert.equal(run.calls[1]?.headers.get('x-api-key'), 'from-agent')
  for (const line of run.lines) assert.ok(!line.includes(secretValue), line)
})

test('the credential follows a same-origin redirect, not a cross-origin one, and is never in a log, an error or an artifact', async () => {
  const answers = [redirect(302, '/b'), redirect(307, 'https://files.example.com/c'), new Response('end')]
  const run = setup({ egress: keyed, answer: (_call, index) => answers[index] ?? new Response('none') })
  const response = await run.egress('https://api.example.com/a', { headers: { 'x-api-key': 'from-agent' } })
  assert.deepEqual(run.calls.map((call) => call.headers.get('x-api-key')), [secretValue, secretValue, null])
  response.headers.forEach((value, name) => assert.ok(!value.includes(secretValue), name))
  const refused = setup({ egress: keyed, answer: () => redirect(302, 'https://evil.example.net/') })
  await assert.rejects(refused.egress('https://api.example.com/a'), (error: Error) => !error.message.includes(secretValue))
  for (const line of [...run.lines, ...refused.lines]) assert.ok(!line.includes(secretValue), line)
  for (const { id, meta } of await run.artifacts.list()) {
    assert.ok(!JSON.stringify(meta).includes(secretValue))
    assert.ok(!new TextDecoder().decode((await run.artifacts.get(id)) ?? new Uint8Array()).includes(secretValue))
  }
})

test('a redirect from a host without a credential to a host with one gets the credential of the hop host', async () => {
  const run = setup({ egress: keyed, answer: (_call, index) => (index === 0 ? redirect(302, 'https://api.example.com/b') : new Response('end')) })
  await run.egress('https://files.example.com/a', { headers: { 'x-api-key': 'from-agent' } })
  assert.deepEqual(run.calls.map((call) => call.headers.get('x-api-key')), ['from-agent', secretValue])
  for (const line of run.lines) assert.ok(!line.includes(secretValue), line)
})

test('a secret that is not a valid header value is refused, and the value is not in the error or the log', async () => {
  const bad = 'line-one\nline-two'
  const run = setup({ egress: keyed, secret: bad })
  await refuses(run.egress('https://api.example.com/a'), /the secret ARCHIVE_KEY for api\.example\.com is not a valid header value/)
  await assert.rejects(run.egress('https://api.example.com/a'), (error: Error) => !error.message.includes('line-one') && !error.message.includes('line-two'))
  assert.equal(run.calls.length, 0)
  assert.equal(run.lines.length, 2)
  for (const line of run.lines) assert.ok(!line.includes('line-one') && !line.includes('line-two'), line)
})

test('a URL or a method with a newline gives one log line', async () => {
  const run = setup()
  await refuses(run.egress('https://evil.example.net/\nnote: egress GET https://api.example.com/x 200 artifact ' + '0'.repeat(64)), /host evil\.example\.net is not in the list/)
  await refuses(run.egress('https://api.example.com/a', { method: 'GET\nnote: egress GET https://api.example.com/x' }), /the request is not valid/)
  assert.equal(run.calls.length, 0)
  assert.equal(run.lines.length, 2)
  for (const line of run.lines) {
    assert.ok(!/[\r\n]/.test(line), line)
    assert.match(line, /^researcher: egress .*\\u000a/)
  }
})

test('an invalid long URL reaches the log without an intermediate length limit', async () => {
  const run = setup()
  const url = 'not-a-url/' + 'x'.repeat(3000)
  await refuses(run.egress(url), /the URL is not valid/)
  assert.deepEqual(run.lines, [`researcher: egress GET ${url} egress refused: the URL is not valid`])
  assert.equal(run.calls.length, 0)
  assert.deepEqual(await run.artifacts.list(), [])
})

test('each final response is an artifact: a 404, an empty body and a null-body status', async () => {
  const answers = [
    new Response('missing', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html; charset=utf-8' } }),
    new Response('', { status: 200 }),
    new Response(null, { status: 204, headers: { etag: '"x"' } }),
  ]
  const run = setup({ answer: (_call, index) => answers[index] ?? new Response('none') })
  const missing = await run.egress('https://api.example.com/missing')
  assert.equal(missing.status, 404)
  assert.equal(missing.statusText, 'Not Found')
  assert.equal(await missing.text(), 'missing')
  const missingMeta = await run.artifacts.meta(missing.headers.get('x-artifact-id') ?? '')
  assert.deepEqual(missingMeta?.labels, { body_sha256: emptySha, status: '404' })
  assert.equal(missingMeta?.media_type, 'text/html; charset=utf-8')
  assert.deepEqual(missingMeta?.source, { url: 'https://api.example.com/missing', method: 'GET' })

  const empty = await run.egress('https://api.example.com/empty')
  assert.equal(empty.headers.get('x-artifact-id'), emptySha)
  assert.equal(await empty.text(), '')
  const emptyMeta = await run.artifacts.meta(emptySha)
  assert.equal(emptyMeta?.media_type, 'text/plain;charset=UTF-8')
  assert.equal(emptyMeta?.size, 0)

  const none = await run.egress('https://api.example.com/none')
  assert.equal(none.status, 204)
  assert.equal(none.body, null)
  assert.equal(none.headers.get('x-artifact-id'), emptySha)
  assert.equal(none.headers.get('etag'), '"x"')
  // Each response gets a separate record, even when two responses have the same empty body.
  assert.notEqual(missing.headers.get('x-provenance-id'), missing.headers.get('x-artifact-id'))
  assert.notEqual(empty.headers.get('x-provenance-id'), emptySha)
  assert.notEqual(none.headers.get('x-provenance-id'), empty.headers.get('x-provenance-id'))
  const noneMeta = await run.artifacts.meta(none.headers.get('x-provenance-id') ?? '')
  assert.deepEqual(noneMeta?.source, { command: 'egress provenance' })
  assert.deepEqual(noneMeta?.labels, { body_sha256: emptySha, status: '204', body: emptySha })
  const record = JSON.parse(new TextDecoder().decode((await run.artifacts.get(none.headers.get('x-provenance-id') ?? '')) ?? new Uint8Array()))
  assert.equal(record.url, 'https://api.example.com/none')
  assert.equal(record.method, 'GET')
  assert.equal(run.lines.length, 3)
  assert.match(run.lines[0] ?? '', /^researcher: egress GET https:\/\/api\.example\.com\/missing 404 artifact [0-9a-f]{64} provenance [0-9a-f]{64}$/)
})

test('the media type falls back to octet-stream, and content-encoding and content-length are dropped', async () => {
  const run = setup({
    answer: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-encoding': 'gzip', 'content-length': '3', 'x-server': 'a' } }),
  })
  const response = await run.egress('https://api.example.com/bin')
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('x-server'), 'a')
  const meta = await run.artifacts.meta(response.headers.get('x-artifact-id') ?? '')
  assert.equal(meta?.media_type, 'application/octet-stream')
})

const checkHost = (lock?: RunLock): EgressHost => ({
  artifacts: memoryArtifacts(),
  secret: (name) => (name === 'ARCHIVE_KEY' || name === 'GITHUB_TOKEN' ? 'value' : undefined),
  ...(lock ? { lock } : {}),
})

test('checkEgress accepts a valid spec', () => {
  checkEgress({ ...base, ...keyed, max_bytes: artifactSizeLimit, web_search: true }, checkHost())
  checkEgress({ ...base, hosts: ['Example.COM.'], credentials: { 'example.com': { header: 'Authorization', secret: 'ARCHIVE_KEY' } } }, checkHost())
})

test('checkEgress refuses a cap that is not an integer from 1 to 32 MiB', () => {
  for (const max_bytes of [0, -1, 1.5, artifactSizeLimit + 1, Number.NaN]) assert.throws(() => checkEgress({ ...base, max_bytes }, checkHost()), /max_bytes/)
})

test('checkEgress refuses a host entry that is not a plain host name', () => {
  for (const name of ['https://api.example.com', 'api.example.com:443', '*.example.com', 'api.example.com/x', '', 'a..b', '-a.com', '[::1]'])
    assert.throws(() => checkEgress({ ...base, hosts: [name] }, checkHost()), /not a plain host name/, name)
})

test('checkEgress refuses a credential for an unlisted host, a bad header, a host secret and a missing secret', () => {
  const credential = (host: string, header: string, secret: string): Egress => ({ ...base, credentials: { [host]: { header, secret } } })
  assert.throws(() => checkEgress(credential('evil.example.net', 'x-api-key', 'ARCHIVE_KEY'), checkHost()), /credential host evil\.example\.net is not in hosts/)
  assert.throws(() => checkEgress(credential('api.example.com', 'x api key', 'ARCHIVE_KEY'), checkHost()), /not a valid HTTP token/)
  assert.throws(() => checkEgress(credential('api.example.com', 'x-api-key', 'GITHUB_TOKEN'), checkHost()), /host secret GITHUB_TOKEN/)
  assert.throws(() => checkEgress(credential('api.example.com', 'x-api-key', 'MISSING_KEY'), checkHost()), /secret MISSING_KEY for api\.example\.com is not set/)
})

test('checkEgress refuses a secret that is not a valid header value, and the message does not have the value', () => {
  for (const value of ['line-one\nline-two', 'line-one\rline-two', 'line-one\0line-two', 'line-one\u0100line-two']) {
    const host: EgressHost = { artifacts: memoryArtifacts(), secret: () => value }
    assert.throws(
      () => checkEgress({ ...base, ...keyed }, host),
      (error: Error) => /secret ARCHIVE_KEY for api\.example\.com is not a valid header value/.test(error.message) && !error.message.includes('line-one'),
      JSON.stringify(value),
    )
  }
})

test('checkEgress refuses web_search while the lock has a pending pattern', () => {
  const lock = runLock(fileLedger(ledgerPath()), ['https://api.example.com/holdout'])
  assert.throws(() => checkEgress({ ...base, web_search: true }, checkHost(lock)), /web_search .* https:\/\/api\.example\.com\/holdout is locked/)
  checkEgress({ ...base, web_search: false }, checkHost(lock))
  lock.unlock('https://api.example.com/holdout')
  checkEgress({ ...base, web_search: true }, checkHost(lock))
})
