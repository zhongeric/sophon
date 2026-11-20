import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkProviders, failedChecksText, probeOutputTokens, probeProvider } from '../src/core/preflight.ts'
import { apiKeyCredential, MissingCredentialError, type Provider } from '../src/core/providers.ts'

type Sent = { url: string; headers: [string, string][]; body: Record<string, unknown> }

function fakeFetch(reply: (url: string) => Response | Promise<Response>) {
  const sent: Sent[] = []
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as [string, string][], body: JSON.parse(init.body as string) as Record<string, unknown> })
    return reply(url)
  }) as typeof fetch
  return { fetch: send, sent }
}

const claude = apiKeyCredential('claude', 'k')
const codex = apiKeyCredential('codex', 'o')
const probe = (reply: Response, provider: Provider = 'claude') => {
  const fake = fakeFetch(() => reply)
  return probeProvider(provider, provider === 'claude' ? claude : codex, 'm', { fetch: fake.fetch })
}

test('a 200 passes, and the request has the model and the smallest output limit', async () => {
  assert.equal(probeOutputTokens.claude, 1)
  assert.equal(probeOutputTokens.codex, 16)
  const fake = fakeFetch(() => new Response('{}'))
  assert.deepEqual(await probeProvider('claude', claude, 'claude-x', { fetch: fake.fetch }), { failed: null, transient: null })
  assert.deepEqual(await probeProvider('codex', codex, 'gpt-x', { fetch: fake.fetch }), { failed: null, transient: null })
  const [first, second] = fake.sent
  assert.equal(first?.url, 'https://api.anthropic.com/v1/messages')
  assert.deepEqual(first?.body, { model: 'claude-x', max_tokens: probeOutputTokens.claude, messages: [{ role: 'user', content: 'ping' }] })
  assert.deepEqual(first?.headers, [['x-api-key', 'k'], ['content-type', 'application/json'], ['anthropic-version', '2023-06-01']])
  assert.equal(second?.url, 'https://api.openai.com/v1/responses')
  assert.deepEqual(second?.body, { model: 'gpt-x', input: 'ping', max_output_tokens: probeOutputTokens.codex })
})

test('a missing key fails without a request, with the message of the credential and the fix of the caller', async () => {
  const fake = fakeFetch(() => new Response('{}'))
  const result = await checkProviders([{ provider: 'codex', model: 'gpt-x' }], (provider) => apiKeyCredential(provider, undefined), {
    fetch: fake.fetch,
    missingKeyFix: (key, provider) => `set ${key} for ${provider}`,
  })
  assert.deepEqual(result, {
    failed: [{ check: 'Provider key (codex)', problem: 'Codex models need OPENAI_API_KEY', fix: 'set OPENAI_API_KEY for codex' }],
    transient: [],
  })
  assert.equal(fake.sent.length, 0)
  const plan = await checkProviders([{ provider: 'claude', model: 'm' }], () => {
    throw new MissingCredentialError('no Claude login in /home; run nc and /login claude')
  })
  assert.deepEqual(plan.failed, [{ check: 'Provider key (claude)', problem: 'no Claude login in /home; run nc and /login claude', fix: 'set ANTHROPIC_API_KEY' }])
})

test('other errors of the credential propagate', async () => {
  await assert.rejects(checkProviders([{ provider: 'claude', model: 'm' }], () => { throw new Error('broken') }), /broken/)
})

test('a refused key, an unknown model, no credit and an exhausted quota fail with a fix', async () => {
  const cases: [Response, Provider, RegExp][] = [
    [new Response('no', { status: 401 }), 'claude', /refused the key \(HTTP 401\)/],
    [new Response('no', { status: 403 }), 'codex', /refused the key \(HTTP 403\)/],
    [new Response('{"error":"model not found"}', { status: 404 }), 'claude', /HTTP 404 \(\{"error":"model not found"\}\)/],
    [new Response('{"error":{"message":"Your credit balance is too low"}}', { status: 400 }), 'claude', /no credit or quota \(HTTP 400.*credit balance/],
    [new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }), 'codex', /no credit or quota \(HTTP 429.*insufficient_quota/],
    [new Response('{"error":{"code":"billing_hard_limit_reached"}}', { status: 400 }), 'codex', /no credit or quota \(HTTP 400.*billing_hard_limit_reached/],
  ]
  for (const [reply, provider, problem] of cases) {
    const { failed, transient } = await probe(reply, provider)
    assert.equal(transient, null)
    assert.equal(failed?.check, `Provider key (${provider})`)
    assert.match(failed?.problem ?? '', problem)
    const key = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    assert.equal(failed?.fix, `check ${key} and the credit or quota of its account`)
  }
})

test('a plain 429, a 5xx, a thrown error and a timeout are transient', async () => {
  for (const status of [429, 500, 529]) {
    const { failed, transient } = await probe(new Response('busy', { status }))
    assert.equal(failed, null)
    assert.match(transient ?? '', new RegExp(`HTTP ${status}`))
  }
  for (const message of ['Request quota exceeded', 'See billing for rate limits']) {
    const body = JSON.stringify({ error: { type: 'requests', message } })
    const { failed, transient } = await probe(new Response(body, { status: 429 }), 'codex')
    assert.equal(failed, null)
    assert.match(transient ?? '', /HTTP 429/)
  }
  const thrown = fakeFetch(() => { throw new TypeError('fetch failed') })
  const network = await probeProvider('claude', claude, 'm', { fetch: thrown.fetch })
  assert.equal(network.failed, null)
  assert.match(network.transient ?? '', /fetch failed/)
  // The timer of AbortSignal.timeout does not keep Node alive, so the fake holds a timer until the abort.
  const hang = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const alive = setTimeout(() => reject(new Error('no timeout')), 5_000)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(alive)
        reject(init.signal?.reason)
      })
    })) as typeof fetch
  const timeout = await probeProvider('codex', codex, 'm', { fetch: hang, timeoutMs: 10 })
  assert.equal(timeout.failed, null)
  assert.match(timeout.transient ?? '', /codex probe of m failed/)
})

test('two providers with one failure and one pass give one failed check, each with the first model', async () => {
  const fake = fakeFetch((url) => new Response('no', { status: url.includes('anthropic') ? 200 : 401 }))
  const models = [
    { provider: 'claude' as const, model: 'claude-a' },
    { provider: 'codex' as const, model: 'gpt-a' },
    { provider: 'claude' as const, model: 'claude-b' },
  ]
  const result = await checkProviders(models, (provider) => (provider === 'claude' ? claude : codex), { fetch: fake.fetch })
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0]?.check, 'Provider key (codex)')
  assert.deepEqual(result.transient, [])
  assert.deepEqual(fake.sent.map(({ body }) => body.model).sort(), ['claude-a', 'gpt-a'])
})

test('failedChecksText lists each check with its fix', () => {
  const text = failedChecksText([
    { check: 'Provider key (claude)', problem: 'ANTHROPIC_API_KEY is not set', fix: 'set ANTHROPIC_API_KEY as a Worker secret' },
    { check: 'Build container', problem: 'no container', fix: 'add the containers section' },
  ])
  assert.equal(
    text,
    '- **Provider key (claude)**: ANTHROPIC_API_KEY is not set. Fix: set ANTHROPIC_API_KEY as a Worker secret\n' +
      '- **Build container**: no container. Fix: add the containers section',
  )
})
