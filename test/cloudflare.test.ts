import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixed, fixtureRepo, jev, scriptFor } from './support/fixture.ts'
import { mockServices } from './support/mock-services.ts'
import { sendWebhook, startWorker, until } from './support/wrangler.ts'

const secret = 'webhook-secret'
const repository = { full_name: 'acme/app' }
const vars = (mock: { url: string }) => ({
  ADMIN_TOKEN: 'admin',
  ALLOWED_USERS: 'Eric',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_URL: `${mock.url}/v1/messages`,
  GITHUB_API_URL: mock.url,
  GITHUB_TOKEN: 'github-token',
  GITHUB_WEBHOOK_SECRET: secret,
  OPENAI_API_KEY: 'openai-key',
  OPENAI_URL: `${mock.url}/v1`,
  PAUSE_POLL_SECONDS: '2',
  TYPESAFE_API_KEY: 'typesafe-key',
  TYPESAFE_URL: `${mock.url}/v1/systemone`,
})
const comment = (login: string, body: string) => ({ action: 'created', comment: { body, user: { login } }, issue: { number: 7, pull_request: {} }, repository })

test('on Cloudflare, /review runs the loop in a Durable Object, asks on the PR, and pushes the fixes', { timeout: 240_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', jev, name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startWorker(vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 120)))}\nrequests: ${mock.state.requests.slice(-15).join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  try {
    assert.equal((await sendWebhook(worker.url, null, 'issue_comment', comment('eric', '/review'))).status, 401)
    assert.deepEqual(await (await sendWebhook(worker.url, secret, 'issue_comment', comment('mallory', '/review'))).json(), { ignored: 'not an allowed user' })

    const started = (await (await sendWebhook(worker.url, secret, 'issue_comment', comment('eric', '/review'))).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    const asked = await until(() => mock.state.comments.find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(asked.body, /May sub return a negative number\?/)

    mock.comment('eric', '/answer\nQ1: b')
    await sendWebhook(worker.url, secret, 'issue_comment', comment('eric', '/answer\nQ1: b'))
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.match(done.body, /May sub return a negative number\? \*\*No, throw an error\*\*/)
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'src/math.ts'), fixed)

    const status = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: { state: string }[] }
    assert.equal(status.runs[0]?.state, 'passed')
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`)).status, 401)
    const providers = new Set(mock.state.turns.filter((turn) => turn.role === 'late-minimize').map((turn) => turn.provider))
    assert.deepEqual(providers, new Set(['codex']))
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /Step 1 findings: minimize=1, rules=0, bugs=1, anti-slop=0/)
  } finally {
    worker.stop()
    mock.close()
  }
})

test('on Cloudflare, a fork PR stops before any work, because its fixes would run in this repository CI', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', headRepo: 'mallory/app', jev, name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startWorker(vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}`
  try {
    await sendWebhook(worker.url, secret, 'issue_comment', comment('eric', '/review --ship'))
    const stopped = await until(() => mock.state.comments.find((entry) => entry.body.includes('stopped run')), 60_000, describe)
    assert.match(stopped.body, /fork PRs are not supported/)
    assert.equal(mock.state.turns.length, 0)
    assert.equal(mock.state.refs.size, 0)
  } finally {
    worker.stop()
    mock.close()
  }
})
