import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appJwt, githubAccess, type GitHubSecrets, type InstallationTokens } from '../src/cloudflare/github-app.ts'
import { StopError } from '../src/core/stop.ts'
import { mockServices } from './support/mock-services.ts'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString())

/** True when the JWT has a valid RS256 signature of the test key. */
function signed(jwt: string): boolean {
  const [header = '', claims = '', signature = ''] = jwt.split('.')
  return verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url'))
}

/** The GitHub mock on an empty directory: the tests use only routes that do not read the repository. */
async function withMock(app: { slug: string; installed: boolean; expiresInSeconds?: number } | undefined, run: (mock: Awaited<ReturnType<typeof mockServices>>) => Promise<void>) {
  const repo = mkdtempSync(join(tmpdir(), 'factory-app-'))
  const mock = await mockServices(repo, {
    app,
    botLogin: 'factory-bot',
    name: 'app',
    owner: 'acme',
    script: () => {
      throw new Error('no model call is expected')
    },
  })
  try {
    await run(mock)
  } finally {
    mock.close()
    rmSync(repo, { force: true, recursive: true })
  }
}

const appSecrets = (url: string): GitHubSecrets => ({ GITHUB_API_URL: url, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: keys.privateKey })

async function stops(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StopError, String(error))
    assert.match(error.message, pattern)
    return true
  })
}

test('the App JWT has the RS256 header, the claims of the clock and a signature that the public key verifies', async () => {
  const now = 1_700_000_000_500
  const jwt = await appJwt('123', keys.privateKey, now)
  const [header = '', claims = ''] = jwt.split('.')
  assert.doesNotMatch(jwt, /[=+/]/)
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(decode(claims), { exp: 1_700_000_000 - 60 + 600, iat: 1_700_000_000 - 60, iss: '123' })
  assert.ok(signed(jwt))
})

test('with the App, many requests use one installation token, and a new one comes 5 minutes or less before it expires', async () => {
  await withMock({ expiresInSeconds: 600, installed: true, slug: 'factory' }, async (mock) => {
    const start = Date.now()
    let clock = start
    const { app, gh } = await githubAccess(appSecrets(mock.url), 'acme', 'app', new Map(), { now: () => clock })
    assert.equal(app, true)
    const lookup = mock.state.authorizations.find((entry) => entry.route === 'GET /repos/acme/app/installation')
    assert.ok(lookup && signed(lookup.authorization.replace(/^Bearer /, '')), 'the installation lookup carries the App JWT')

    for (let index = 0; index < 3; index++) await gh.json('GET', '/repos/acme/app')
    clock = start + 4 * 60_000
    await gh.json('GET', '/repos/acme/app')
    clock = start + 5 * 60_000 + 1_000
    await gh.json('GET', '/repos/acme/app')

    const used = mock.state.authorizations.filter((entry) => entry.route === 'GET /repos/acme/app').map((entry) => entry.authorization)
    assert.deepEqual(used, [...Array(4).fill('Bearer ghs_installation1'), 'Bearer ghs_installation2'])
    const created = mock.state.authorizations.filter((entry) => entry.route === 'POST /app/installations/42/access_tokens')
    assert.equal(created.length, 2)
    assert.ok(created.every((entry) => signed(entry.authorization.replace(/^Bearer /, ''))))
  })
})

test('the cache that the caller keeps gives the token to a new client', async () => {
  await withMock({ installed: true, slug: 'factory' }, async (mock) => {
    const cache: InstallationTokens = new Map()
    await (await githubAccess(appSecrets(mock.url), 'acme', 'app', cache)).gh.json('GET', '/repos/acme/app')
    await (await githubAccess(appSecrets(mock.url), 'acme', 'app', cache)).gh.json('GET', '/repos/acme/app')
    assert.equal(mock.state.requests.filter((route) => route === 'POST /app/installations/42/access_tokens').length, 1)
  })
})

test('without the App secrets, requests carry GITHUB_TOKEN and no App route is called', async () => {
  await withMock({ installed: true, slug: 'factory' }, async (mock) => {
    const { app, gh } = await githubAccess({ GITHUB_API_URL: mock.url, GITHUB_TOKEN: 'personal' }, 'acme', 'app', new Map())
    assert.equal(app, false)
    await gh.json('GET', '/repos/acme/app')
    assert.deepEqual(mock.state.authorizations, [{ authorization: 'Bearer personal', route: 'GET /repos/acme/app' }])
  })
})

test('with the App secrets and GITHUB_TOKEN, requests carry the installation token, never GITHUB_TOKEN', async () => {
  await withMock({ installed: true, slug: 'factory' }, async (mock) => {
    const { app, gh } = await githubAccess({ ...appSecrets(mock.url), GITHUB_TOKEN: 'personal' }, 'acme', 'app', new Map())
    assert.equal(app, true)
    await gh.json('GET', '/repos/acme/app')
    assert.ok(mock.state.authorizations.every((entry) => entry.authorization !== 'Bearer personal'))
    assert.deepEqual(mock.state.authorizations.at(-1), { authorization: 'Bearer ghs_installation1', route: 'GET /repos/acme/app' })
  })
})

test('one App secret alone, or no credential at all, stops before any request and names the missing secret', async () => {
  await withMock({ installed: true, slug: 'factory' }, async (mock) => {
    await stops(githubAccess({ GITHUB_API_URL: mock.url, GITHUB_APP_ID: '123', GITHUB_TOKEN: 'personal' }, 'acme', 'app', new Map()), /^GITHUB_APP_PRIVATE_KEY is not set/)
    await stops(githubAccess({ GITHUB_API_URL: mock.url, GITHUB_APP_PRIVATE_KEY: keys.privateKey }, 'acme', 'app', new Map()), /^GITHUB_APP_ID is not set/)
    await stops(githubAccess({ GITHUB_API_URL: mock.url }, 'acme', 'app', new Map()), /^GITHUB_TOKEN is not set/)
    assert.deepEqual(mock.state.requests, [])
  })
})

test('a PKCS#1 key stops before any request and names GITHUB_APP_PRIVATE_KEY', async () => {
  await withMock({ installed: true, slug: 'factory' }, async (mock) => {
    assert.match(pkcs1.privateKey, /BEGIN RSA PRIVATE KEY/)
    await stops(githubAccess({ ...appSecrets(mock.url), GITHUB_APP_PRIVATE_KEY: pkcs1.privateKey }, 'acme', 'app', new Map()), /^GITHUB_APP_PRIVATE_KEY is not an RSA key in PKCS#8/)
    assert.deepEqual(mock.state.requests, [])
  })
})

test('a repository without the App stops with the install link of the slug from GET /app', async () => {
  await withMock({ installed: false, slug: 'sophon-factory' }, async (mock) => {
    await stops(githubAccess(appSecrets(mock.url), 'acme', 'app', new Map()), /https:\/\/github\.com\/apps\/sophon-factory\/installations\/new/)
    assert.deepEqual(mock.state.requests, ['GET /repos/acme/app/installation', 'GET /app'])
    assert.ok(mock.state.authorizations.every((entry) => signed(entry.authorization.replace(/^Bearer /, ''))))
  })
})
