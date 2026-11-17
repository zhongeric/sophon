import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWorkerCredentials, egressUrlFetch, workerSecret } from '../src/cloudflare/egress.ts'
import { StopError } from '../src/core/stop.ts'

const value = 'value-that-must-not-leak'
const refusedNames = ['ADMIN_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'MODELS', 'EGRESS_URL']

test('a credential that names a host secret or a Worker setting stops with the host and the name, without the value', () => {
  for (const name of refusedNames) {
    assert.throws(
      () => checkWorkerCredentials({ 'archive.example.org': { header: 'x-api-key', secret: name } }),
      (error: unknown) => {
        assert.ok(error instanceof StopError)
        assert.match(error.message, new RegExp(`archive\\.example\\.org names ${name}\\b`))
        assert.match(error.message, /wrangler secret put/)
        assert.ok(!error.message.includes(value))
        return true
      },
    )
    assert.equal(workerSecret({ [name]: value })(name), undefined)
  }
})

test('a credential that names a Worker secret passes, and the reader returns its value', () => {
  checkWorkerCredentials({ 'archive.example.org': { header: 'x-api-key', secret: 'ARCHIVE_TOKEN' } })
  checkWorkerCredentials(undefined)
  assert.equal(workerSecret({ ARCHIVE_TOKEN: 'key-1' })('ARCHIVE_TOKEN'), 'key-1')
})

test('the reader ignores values that are not non-empty strings', () => {
  const env: unknown = { EMPTY: '', NUMBER: 7, OBJECT: { get: () => 'x' }, NULL: null }
  for (const name of ['EMPTY', 'NUMBER', 'OBJECT', 'NULL', 'MISSING', 'toString', 'constructor']) assert.equal(workerSecret(env)(name), undefined)
  assert.equal(workerSecret(null)('ARCHIVE_TOKEN'), undefined)
  assert.equal(workerSecret('ARCHIVE_TOKEN')('ARCHIVE_TOKEN'), undefined)
})

test('the EGRESS_URL fetch sends the request to the host path with the same method, headers, body and redirect mode', async () => {
  const sent: { url: string; method: string; headers: Headers; body: string; redirect: string | undefined }[] = []
  const send: typeof fetch = async (input, init) => {
    const body = init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : ''
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body, redirect: init?.redirect })
    return new Response('ok')
  }
  const rewrite = egressUrlFetch('http://127.0.0.1:8788/egress/', send)

  const post = await rewrite('https://archive.example.org/api/search?q=a%20b&page=2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'key-1' },
    body: '{"q":"a"}',
    redirect: 'manual',
  })
  assert.equal(await post.text(), 'ok')
  await rewrite('https://archive.example.org/pages/1')

  assert.equal(sent.length, 2)
  const [first, second] = sent
  assert.equal(first?.url, 'http://127.0.0.1:8788/egress/archive.example.org/api/search?q=a%20b&page=2')
  assert.equal(first?.method, 'POST')
  assert.equal(first?.headers.get('x-api-key'), 'key-1')
  assert.equal(first?.headers.get('content-type'), 'application/json')
  assert.equal(first?.body, '{"q":"a"}')
  assert.equal(first?.redirect, 'manual')
  assert.equal(second?.url, 'http://127.0.0.1:8788/egress/archive.example.org/pages/1')
  assert.equal(second?.method, 'GET')
  assert.equal(second?.body, '')
  assert.equal(second?.redirect, 'follow')
})
