import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dispatcher, MissingCredentialError } from '../src/core/providers.ts'
import { credential } from '../src/node/credentials.ts'

const request = (endpoint: string, headers: [string, string][] = []) => ({
  body: new Uint8Array(),
  endpoint,
  headers,
  method: 'POST',
  origin: null,
  provider: 'claude' as const,
  subagent: null,
})

test('keys come from the environment, and a missing key stops the run', () => {
  assert.deepEqual(credential('claude', { env: { ANTHROPIC_API_KEY: 'k' } }).headers(), [['x-api-key', 'k']])
  assert.deepEqual(credential('codex', { env: { OPENAI_API_KEY: 'o' } }).headers(), [['authorization', 'Bearer o']])
  assert.throws(() => credential('codex', { env: {} }), MissingCredentialError)
})

test('the plan login is read from nc, and an expired one stops the run', () => {
  const home = mkdtempSync(join(tmpdir(), 'factory-nc-'))
  const save = (expires_at: number) =>
    writeFileSync(join(home, 'claude.json'), JSON.stringify({ claude: { revision: 1, payload: JSON.stringify({ state: { kind: 'Ready', token: { access: 'tok', expires_at } } }) } }))
  save(Date.now() + 3_600_000)
  const plan = credential('claude', { claudePlan: true, env: { NANOCODE_HOME: home } })
  assert.equal(plan.subscription, true)
  assert.deepEqual(plan.headers(), [['authorization', 'Bearer tok'], ['anthropic-beta', 'oauth-2025-04-20']])
  save(Date.now())
  assert.throws(() => plan.headers(), /expired/)
})

test('dispatch signs only requests to the credential origin', async () => {
  const sent: { url: string; headers: [string, string][] }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as [string, string][] })
    return new Response('ok')
  }) as typeof fetch
  try {
    const dispatch = dispatcher({ claude: { endpoint: 'https://api.anthropic.com/v1/messages', subscription: false, headers: () => [['anthropic-beta', 'oauth'], ['x-api-key', 'k']] } }, 'claude')
    const timing = {} as never
    await dispatch(request('https://api.anthropic.com/v1/messages', [['anthropic-beta', 'context-1']]), new AbortController().signal, timing)
    assert.deepEqual(sent[0]?.headers, [['anthropic-beta', 'context-1,oauth'], ['x-api-key', 'k']])
    await assert.rejects(dispatch(request('https://evil.example.com/v1/messages'), new AbortController().signal, timing), /refusing to sign/)
    assert.equal(sent.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})
