import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { developRepo, developScript, sources } from './support/develop.ts'
import { fixed, fixtureRepo, lightFixed, scriptFor } from './support/fixture.ts'
import { mockServices } from './support/mock-services.ts'
import { sendWebhook, startWorker, until } from './support/wrangler.ts'

const secret = 'webhook-secret'
const repository = { full_name: 'acme/app' }
const vars = (mock: { url: string }) => ({
  ADMIN_TOKEN: 'admin',
  ALLOWED_USERS: 'Maintainer',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_URL: `${mock.url}/v1/messages`,
  GITHUB_API_URL: mock.url,
  GITHUB_TOKEN: 'github-token',
  GITHUB_WEBHOOK_SECRET: secret,
  OPENAI_API_KEY: 'openai-key',
  OPENAI_URL: `${mock.url}/v1`,
  PAUSE_POLL_SECONDS: '2',
})
/** The vars with the mock machine, for review runs whose config has tests: they run the tests on a build machine. */
const withMachine = (mock: { url: string }) => ({ ...vars(mock), MACHINE_URL: `${mock.url}/machine` })
/** Starts the Worker, and closes the mock when wrangler dev does not start. */
async function startFor(mock: { close: () => Promise<void> }, ...args: Parameters<typeof startWorker>) {
  try {
    return await startWorker(...args)
  } catch (error) {
    await mock.close()
    throw error
  }
}
const comment = (login: string, body: string) => ({ action: 'created', comment: { body, user: { login } }, issue: { number: 7, pull_request: {} }, repository })

test('on Cloudflare, development collects a stopped review before a budget raise starts its replacement', { timeout: 360_000 }, async () => {
  const { repo } = developRepo()
  const issues = { 5: { body: 'Add sub and mul next to add, with tests.', title: 'Add sub and mul' } }
  const mock = await mockServices(repo, { botLogin: 'factory-bot', issues, name: 'app', owner: 'acme', script: developScript() })
  const free = { input: 0, cached_input: 0, cache_write: 0, output: 0 }
  const worker = await startFor(mock, {
    ...vars(mock),
    MACHINE_URL: `${mock.url}/machine`,
    MODEL_PRICES: JSON.stringify({ 'claude-opus-5-5': free, 'gpt-6.1-sol': { ...free, output: 1_000_000 } }),
  })
  const headers = { authorization: 'Bearer admin', 'content-type': 'application/json' }
  const on = (issue: number) => mock.state.comments.filter((entry) => entry.issue === issue)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
  const status = async (issue: number) => (await (await fetch(`${worker.url}/runs/acme/app/${issue}`, { headers })).json()) as { runs: { run: string; state: string }[] }
  const answer = async (body: string) => {
    mock.comment('maintainer', body, 5)
    await sendWebhook(worker.url, secret, 'issue_comment', { action: 'created', comment: { body, user: { login: 'maintainer' } }, issue: { number: 5 }, repository })
  }
  try {
    const started = await fetch(`${worker.url}/develop/acme/app/5`, { body: JSON.stringify({ budget: 1 }), headers, method: 'POST' })
    assert.equal(started.status, 202)
    // The intake agent raised no user question, so the first question of the run is the budget question (D11).
    const asked = await until(() => on(5).find((entry) => /batch=budget\./.test(entry.body)), 300_000, describe)
    assert.ok(!on(5).some((entry) => entry.body.includes('Is this the ask?')), describe())
    assert.match(asked.body, /Raise the budget or stop the run\?/)
    assert.match(asked.body, /Raise the budget to \$\d+\.\d{2} \(recommended\)/)
    // The stopped review spent more than twice the budget: the run posted the notice before the question.
    const noticed = on(5).findIndex((entry) => /of its budget of \$1\.00\. The run continues\./.test(entry.body))
    assert.ok(noticed !== -1 && noticed < on(5).indexOf(asked), describe())
    const pull = [...mock.state.pulls.keys()][0]
    assert.ok(pull !== undefined, describe())
    const first = await status(pull)
    assert.equal(first.runs.length, 1, describe())
    assert.equal(first.runs[0]?.state, 'failed')
    await until(() => on(pull).find((entry) => entry.body.includes('Reason: cost budget.')), 30_000, describe)

    await fetch(`${worker.url}/runs/acme/app/5/resume`, { headers, method: 'POST' })
    await until(async () => (await status(5)).runs[0]?.state === 'paused' ? true : undefined, 30_000, describe)
    assert.equal((await status(pull)).runs.length, 1, describe())
    await answer('/answer\nQ1: 1000')
    const done = await until(() => on(5).find((entry) => entry.body.startsWith('# Development run: READY')), 180_000, describe)
    assert.equal((await status(pull)).runs.length, 2, describe())
    const totals = on(pull).filter((entry) => entry.body.startsWith('### agent-factory:')).map((entry) => {
      const total = /^\| \*\*Total\*\* \|.*\| \$([\d.]+) \|$/m.exec(entry.body)
      assert.ok(total, entry.body)
      return Number(total[1])
    })
    assert.equal(totals.length, 2, describe())
    const cumulative = /^\| review\.1 \| review loop \|.*\| \$([\d.]+) \|$/m.exec(done.body)
    assert.ok(cumulative, done.body)
    assert.equal(Number(cumulative[1]), totals.reduce((a, b) => a + b, 0))
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, /review runs the loop in a Durable Object, asks on the PR, pushes the fixes, and the close of the PR prunes them', { timeout: 240_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 120)))}\nrequests: ${mock.state.requests.slice(-15).join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  try {
    assert.equal((await sendWebhook(worker.url, null, 'issue_comment', comment('maintainer', '/review'))).status, 401)
    assert.deepEqual(await (await sendWebhook(worker.url, secret, 'issue_comment', comment('mallory', '/review'))).json(), { ignored: 'not an allowed user' })

    const started = (await (await sendWebhook(worker.url, secret, 'issue_comment', comment('maintainer', '/review'))).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    const asked = await until(() => mock.state.comments.find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(asked.body, /May sub return a negative number\?/)
    // The run adds the label of its kind at its start. The repository had no such label, so the run made it first.
    assert.deepEqual(mock.state.labels.get(7), ['agent-review'])
    assert.deepEqual([...mock.state.repoLabels], ['agent-review'])

    mock.comment('maintainer', '/answer\nQ1: b')
    await sendWebhook(worker.url, secret, 'issue_comment', comment('maintainer', '/answer\nQ1: b'))
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.match(done.body, /CI \(push\): pass/)
    assert.match(done.body, /May sub return a negative number\? \*\*No, throw an error\*\*/)
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'src/math.ts'), fixed)
    // The signing check also reads the rules of the publish branch.
    assert.ok(mock.state.requests.includes(`GET /repos/acme/app/rules/branches/${encodeURIComponent(`factory/${started.run}`)}`))

    const status = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: { state: string }[] }
    assert.equal(status.runs[0]?.state, 'passed')
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`)).status, 401)
    const providers = new Set(mock.state.turns.filter((turn) => turn.role === 'late-minimize').map((turn) => turn.provider))
    assert.deepEqual(providers, new Set(['codex']))
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /Step 1 findings: host=0, minimize=1, rules=0, bugs=1, anti-slop=0/)
    // The config has tests, so the run tests on the build machine: the agents that run tests get run_tests, not the text that CI runs them.
    const told = (role: string) => mock.state.turns.some((turn) => turn.role === role && turn.request.includes('This run has no run_tests tool'))
    const offered = (role: string) => mock.state.turns.some((turn) => turn.role === role && turn.request.includes('Run specific test files of /repo'))
    assert.deepEqual([told('patch'), told('bugs'), told('minimize')], [false, false, false])
    assert.deepEqual([offered('patch'), offered('bugs')], [true, true])

    // The sweep keeps the fix branch while the PR is open. The close of the PR prunes it, but never the head branch outside factory/.
    const fixes = `factory/${started.run}`
    assert.equal((await fetch(`${worker.url}/prune/acme/app`, { method: 'POST' })).status, 401)
    const swept = await fetch(`${worker.url}/prune/acme/app`, { headers: { authorization: 'Bearer admin' }, method: 'POST' })
    assert.equal(swept.status, 200)
    assert.deepEqual(await swept.json(), { deleted: [], failed: [], kept: [{ name: fixes, reason: 'unapplied review fixes' }] })
    mock.closePull(7, false)
    const closed = { action: 'closed', pull_request: { head: { ref: 'feature' }, number: 7 }, repository }
    assert.deepEqual(await (await sendWebhook(worker.url, secret, 'pull_request', closed)).json(), { deleted: [{ name: fixes, rule: 'stranded' }], failed: [], kept: [] })
    assert.deepEqual(mock.state.deleted, [fixes])
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a fork PR stops before any work, because its fixes would run in this repository CI', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', headRepo: 'mallory/app', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}`
  try {
    await sendWebhook(worker.url, secret, 'issue_comment', comment('maintainer', '/review --ship'))
    const stopped = await until(() => mock.state.comments.find((entry) => entry.body.includes('stopped run')), 60_000, describe)
    assert.match(stopped.body, /fork PRs are not supported/)
    assert.equal(mock.state.turns.length, 0)
    assert.equal(mock.state.refs.size, 0)
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a /review patch agent that breaks a test gets the failing output at its log, fixes the cause, and the host accepts the log', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ breakFirst: true, runQuestion: true, tests: true }) })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    const started = (await (await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: { authorization: 'Bearer admin' }, method: 'POST' })).json()) as { run: string }
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 150_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'src/math.ts'), fixed)
    const output = mock.state.turns.filter((turn) => turn.role === 'patch' && turn.output).map((turn) => turn.output).join('\n')
    assert.match(output, /refused: .*the targeted tests of your edits failed \(test\/add\.test\.ts, test\/sub\.test\.ts\)/)
    assert.match(output, /3 !== 2/)
    assert.doesNotMatch(output, /FAILING PATCH ACCEPTED/)
    assert.match(output, /checks: syntax=skipped smoke=pass/)
    // The gate ran the targeted tests on the machine, in the directory of the review run.
    const gate = mock.state.commands.filter((entry) => entry.cwd === `review/${started.run}` && entry.argv.join(' ').includes("--test 'test/add.test.ts' 'test/sub.test.ts'"))
    assert.ok(gate.length >= 2, JSON.stringify(mock.state.commands.map((entry) => [entry.cwd, entry.argv.join(' ').slice(0, 120)])))
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a /review whose config has ci runs ci on the machine as its final checks and reads no GitHub CI (D15)', { timeout: 180_000 }, async () => {
  const command = 'env -u NODE_TEST_CONTEXT node --test test/add.test.ts test/sub.test.ts'
  // The config has ci and no tests, so the ci alone gets the build machine.
  const repo = fixtureRepo({ config: { ci: { fixture: command }, tests: null } })
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ runQuestion: true, tests: false }) })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    const started = (await (await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: { authorization: 'Bearer admin' }, method: 'POST' })).json()) as { run: string }
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 150_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'src/math.ts'), fixed)
    // The patch gate and the final checks ran ci on the machine, in the directory of the review run.
    const ci = mock.state.commands.filter((entry) => entry.cwd === `review/${started.run}` && entry.argv.join(' ').includes(command))
    assert.ok(ci.length >= 2, JSON.stringify(mock.state.commands.map((entry) => [entry.cwd, entry.argv.join(' ').slice(0, 120)])))
    assert.deepEqual(mock.state.requests.filter((route) => route.includes('/actions/runs') || route.endsWith('/status')), [])
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a review whose config has tests fails the preflight when the Worker has no container and no machine', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, vars(mock))
  const admin = { authorization: 'Bearer admin' }
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: admin, method: 'POST' })
    const stopped = await until(() => mock.state.comments.find((entry) => entry.body.includes('did not start run')), 60_000, describe)
    assert.match(stopped.body, /^agent-factory did not start run `pr-7-[^`]+`: the preflight found failed checks\./)
    assert.match(stopped.body, /- \*\*Build container\*\*: this Worker has no container for builds\. Fix: add the containers section of wrangler\.jsonc and deploy again/)
    assert.match(stopped.body, /continue the run with `npm run remote -- resume acme\/app#7`\.$/)
    assert.equal(mock.state.comments.length, 1, describe())
    assert.equal(mock.state.turns.length, 0)
    const status = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin })).json()) as { runs: { state: string; note: string }[] }
    assert.equal(status.runs[0]?.state, 'error')
    assert.match(status.runs[0]?.note ?? '', /Build container/)
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, development and research runs fail the preflight with one comment each: the development run checks CI on the default branch', { timeout: 120_000 }, async () => {
  const mock = await mockServices(fixtureRepo(), { botLogin: 'factory-bot', name: 'app', owner: 'acme', script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, vars(mock))
  const admin = { authorization: 'Bearer admin' }
  const on = (issue: number) => mock.state.comments.filter((entry) => entry.issue === issue)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 300)]))}\nworker:\n${worker.output().slice(-3000)}`
  const failed = async (kind: string, issue: number) => {
    await fetch(`${worker.url}/${kind}/acme/app/${issue}`, { body: '{}', headers: admin, method: 'POST' })
    const stopped = await until(() => on(issue).find((entry) => entry.body.includes('did not start run')), 60_000, describe)
    assert.equal(on(issue).length, 1, describe())
    assert.equal(mock.state.turns.length, 0, describe())
    const status = (await (await fetch(`${worker.url}/runs/acme/app/${issue}`, { headers: admin })).json()) as { runs: { state: string; note: string }[] }
    assert.equal(status.runs[0]?.state, 'error')
    assert.match(status.runs[0]?.note ?? '', /^the preflight found failed checks: /)
    return stopped.body
  }
  try {
    mock.state.workflows = false
    const developed = await failed('develop', 5)
    assert.match(developed, /^agent-factory did not start run `dev-5-[^`]+`: the preflight found failed checks\./)
    assert.match(developed, /- \*\*CI workflow\*\*: main has no workflow file in \.github\/workflows/)
    assert.match(developed, /- \*\*Build container\*\*: this Worker has no container for builds/)
    const researched = await failed('research', 9)
    assert.match(researched, /^agent-factory did not start run `research-9-[^`]+`: the preflight found failed checks\./)
    assert.match(researched, /- \*\*Build container\*\*: this Worker has no container for builds/)
    assert.doesNotMatch(researched, /CI workflow|Provider key|GitHub access/)
    assert.deepEqual(new Set(mock.state.probes.map((probe) => probe.provider)), new Set(['claude', 'codex']))
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, with the GitHub App secrets, a repository without the App stops the run before any work, with the install link in the note', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { app: { installed: false, slug: 'sophon-factory' }, botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
  const worker = await startFor(mock, { ...vars(mock), GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey })
  const admin = { authorization: 'Bearer admin' }
  const describe = () => `requests: ${mock.state.requests.join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin, method: 'POST' })
    const stopped = await until(async () => {
      const status = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin })).json()) as { runs: { state: string; note: string }[] }
      return status.runs[0]?.state === 'error' ? status.runs[0] : undefined
    }, 60_000, describe)
    assert.match(stopped.note, /https:\/\/github\.com\/apps\/sophon-factory\/installations\/new/)
    assert.match(stopped.note, /GitHub access.*Fix: install the GitHub App on acme\/app/)
    assert.equal(mock.state.comments.length, 0)
    assert.equal(mock.state.turns.length, 0)
    assert.equal(mock.state.requests.filter((route) => route.startsWith('POST /v1/')).length, 0)
    const lookup = mock.state.authorizations.find((entry) => entry.route === 'GET /repos/acme/app/installation')
    assert.match(lookup?.authorization ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    assert.ok(!mock.state.authorizations.some((entry) => entry.authorization.includes('github-token')), describe())
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, the App webhook secret replaces the webhook secret, and comment, issue and PR events of the App bot start no run', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { app: { installed: true, slug: 'sophon-factory' }, botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
  const appSecret = 'app-webhook-secret'
  // The bot is an allowed user here, so only the bot filter keeps its /review and labels from starting runs.
  const worker = await startFor(mock, { ...vars(mock), ALLOWED_USERS: 'Maintainer,sophon-factory[bot]', GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: appSecret })
  const describe = () => `requests: ${mock.state.requests.join(', ')}\nworker:\n${worker.output().slice(-3000)}`
  const appLookups = () => mock.state.requests.filter((route) => route === 'GET /app').length
  const bot = { login: 'Sophon-Factory[bot]' }
  try {
    assert.equal((await sendWebhook(worker.url, secret, 'issue_comment', comment('mallory', '/review'))).status, 401)
    assert.deepEqual(await (await sendWebhook(worker.url, appSecret, 'issue_comment', { ...comment('mallory', '/review'), sender: { login: 'mallory' } })).json(), { ignored: 'not an allowed user' })
    // The ping of the App has no repository.
    const ping = await sendWebhook(worker.url, appSecret, 'ping', { hook_id: 1, zen: 'Keep it logically awesome.' })
    assert.equal(ping.status, 202)
    assert.deepEqual(await ping.json(), { ignored: 'ping' })
    assert.equal(appLookups(), 0, describe())

    const ignored = { ignored: 'the App bot' }
    assert.deepEqual(await (await sendWebhook(worker.url, appSecret, 'issue_comment', { ...comment('sophon-factory[bot]', '/review'), sender: bot })).json(), ignored)
    const label = (name: string) => ({ action: 'labeled', label: { name }, repository, sender: bot })
    assert.deepEqual(await (await sendWebhook(worker.url, appSecret, 'pull_request', { ...label('agent-review'), pull_request: { number: 7 } })).json(), ignored)
    assert.deepEqual(await (await sendWebhook(worker.url, appSecret, 'issues', { ...label('agent-develop'), issue: { number: 5 } })).json(), ignored)
    assert.equal(appLookups(), 1, describe())

    const workflow = { action: 'completed', repository, sender: bot, workflow_run: { head_branch: 'factory/pr-7-x', pull_requests: [{ number: 7 }] } }
    assert.deepEqual(await (await sendWebhook(worker.url, appSecret, 'workflow_run', workflow)).json(), { woke: [7] })
    assert.equal(appLookups(), 1, describe())
    for (const number of [5, 7]) {
      const status = (await (await fetch(`${worker.url}/runs/acme/app/${number}`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: unknown[] }
      assert.deepEqual(status.runs, [], describe())
    }
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, the admin route starts a run, and the run picks up the answer without the webhook', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 120)))}`
  const admin = { authorization: 'Bearer admin', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`, { method: 'POST' })).status, 401)
    // A budget that is not a positive number of USD gets 400, and no run starts.
    const refused = await fetch(`${worker.url}/runs/acme/app/7`, { body: JSON.stringify({ budget: 0 }), headers: admin, method: 'POST' })
    assert.equal(refused.status, 400)
    assert.match(await refused.text(), /budget must be a positive number/)
    const refusedDevelop = await fetch(`${worker.url}/develop/acme/app/5`, { body: JSON.stringify({ budget: 'abc' }), headers: admin, method: 'POST' })
    assert.equal(refusedDevelop.status, 400)
    assert.equal((await fetch(`${worker.url}/develop/acme/app/5`, { body: 'null', headers: admin, method: 'POST' })).status, 400)
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`, { body: 'null', headers: admin, method: 'POST' })).status, 400)
    for (const number of [5, 7]) {
      const status = (await (await fetch(`${worker.url}/runs/acme/app/${number}`, { headers: admin })).json()) as { runs: unknown[] }
      assert.deepEqual(status.runs, [])
    }
    const started = (await (await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: admin, method: 'POST' })).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    const again = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin, method: 'POST' })).json()) as { run: string; started: boolean }
    assert.deepEqual(again, { run: started.run, started: false })

    const asked = await until(() => mock.state.comments.find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(mock.state.comments[0]!.body, /for `Maintainer`/)
    assert.doesNotMatch(mock.state.comments[0]!.body, /@/)
    // answerersOf gives the ALLOWED_USERS fallback in lower case, and GitHub mentions ignore case.
    assert.match(asked.body.split('\n')[0]!, /^@maintainer$/i)
    assert.deepEqual(mock.state.labels.get(7), ['agent-review'])
    mock.comment('maintainer', '/answer recommended')
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/)
    assert.doesNotMatch(done.body, /@Maintainer/i)
    assert.match(done.body, /May sub return a negative number\? \*\*Yes, return -2\*\* \(recommended\)/)
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, /openapi.json needs no token, has the origin of the Worker, and names only routes that the Worker answers', { timeout: 120_000 }, async () => {
  const worker = await startWorker({ ADMIN_TOKEN: 'admin' })
  try {
    const response = await fetch(`${worker.url}/openapi.json`)
    assert.equal(response.status, 200)
    const spec = (await response.json()) as { servers: { url: string }[]; paths: Record<string, Record<string, unknown>> }
    assert.deepEqual(spec.servers, [{ url: worker.url }])
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => key !== 'parameters')
        .map((method) => ({ method: method.toUpperCase(), path: path.replace('{owner}', 'acme').replace('{repo}', 'app').replace('{number}', '7') })),
    )
    assert.equal(operations.length, 6)
    for (const { method, path } of operations) {
      // A body that is not a JSON object stops a start route before it starts a run.
      const init = { headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, method, ...(method === 'POST' ? { body: '[]' } : {}) }
      const { status } = await fetch(`${worker.url}${path}`, init)
      assert.ok(status !== 404 && status !== 405, `${method} ${path} answered ${status}`)
    }
  } finally {
    await worker.stop()
  }
})

test('on Cloudflare, a docs and tests only change takes the light loop, with host findings from the virtual git diff', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo({ light: true })
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    const started = (await (await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: { authorization: 'Bearer admin' }, method: 'POST' })).json()) as { run: string }
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.deepEqual([...new Set(mock.state.turns.map((turn) => turn.role))], ['light'])
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'test/Vault.t.sol'), lightFixed.test)
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /TRIAGE path=light reason=docs-or-tests-only/)
    assert.match(report, /Light review: commit [0-9a-f]{12}; applied: host-001 .*; host-002 /)
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, deleted source files and the old paths of renamed source files require the full loop', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo({ light: true })
  // The fixture has no usable key, so its own commits are unsigned.
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' })
  git('checkout', '-q', 'main')
  writeFileSync(join(repo, 'src/removed.ts'), 'export const removed = true\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'add source file')
  git('checkout', '-q', 'feature')
  git('merge', '-q', '--no-edit', 'main')
  git('rm', '-q', 'src/removed.ts')
  git('mv', 'src/math.ts', 'docs/math.md')
  git('commit', '-q', '-m', 'remove and rename source files')
  const mock = await mockServices(repo, {
    botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7,
    script: ({ role, output, request }) => {
      if (output !== null) return { text: 'done' }
      if (role === 'questions') return { cell: 'await tools.submit_questions({ questions: [] })' }
      if (role === 'intent') return { cell: 'await tools.submit_verdict({ satisfied: true, gaps: [], summary: "The change removes source files" })' }
      if (role === 'patch') {
        // The two host findings are in two files, so two patch agents get one each.
        const fixes = [
          { id: 'host-001', path: 'docs/v2.md', content: lightFixed.docs, change: 'wrote for example' },
          { id: 'host-002', path: 'test/Vault.t.sol', content: lightFixed.test, change: 'renamed the test' },
        ].filter((fix) => request.includes(fix.id))
        const applied = JSON.stringify(fixes.map(({ id, change }) => ({ id, change })))
        return {
          cell: [
            ...fixes.map((fix) => `await tools.Write({ file_path: '/repo/${fix.path}', content: ${JSON.stringify(fix.content)} })`),
            `await tools.submit_patch_log({ applied: ${applied}, skipped: [], deferred: [] })`,
          ].join('\n'),
        }
      }
      return { cell: 'await tools.submit_findings({ findings: [] })' }
    },
  })
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: { authorization: 'Bearer admin' }, method: 'POST' })
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /TRIAGE path=full reason=not-docs-or-tests files=[^\n`]*src\/math\.ts/)
    assert.match(report, /TRIAGE path=full reason=not-docs-or-tests files=[^\n`]*src\/removed\.ts/)
    assert.match(report, /Step 1 patch: commit [0-9a-f]{12} \(2 patch agents at the same time\); applied: host-001 .*; host-002 /)
    assert.ok(mock.state.turns.some((turn) => turn.role === 'minimize'))
    assert.ok(!mock.state.turns.some((turn) => turn.role === 'light'))
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a missing permission stops the run at once, and resume continues it from the ledger', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo()
  // The open question is a run question, so the run asks nothing on the PR (D11).
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ runQuestion: true, tests: false }) })
  mock.state.ciStatus = 403
  const worker = await startFor(mock, withMachine(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}`
  const admin = { authorization: 'Bearer admin' }
  const modelCalls = () => mock.state.requests.filter((route) => route.startsWith('POST /v1/')).length
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin, method: 'POST' })
    const stopped = await until(() => mock.state.comments.find((entry) => entry.body.includes('stopped run')), 120_000, describe)
    assert.match(stopped.body, /HTTP 403.* Check the permissions of GITHUB_TOKEN\. .*npm run remote -- resume acme\/app#7/)
    assert.equal(mock.state.requests.filter((route) => route.endsWith('/actions/runs')).length, 1)

    // The webhook path does not restart a stopped run. Only the admin route does.
    assert.deepEqual(await (await sendWebhook(worker.url, secret, 'issue_comment', comment('maintainer', '/answer recommended'))).json(), { resumed: false })
    const calls = modelCalls()
    mock.state.ciStatus = 200
    const resume = (pr: number) => fetch(`${worker.url}/runs/acme/app/${pr}/resume`, { headers: admin, method: 'POST' })
    assert.deepEqual(await (await resume(7)).json(), { reason: 'started the run again from its ledger after the error', resumed: true, state: 'error' })
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/)
    assert.ok(!mock.state.comments.some((entry) => entry.body.includes('agent-factory:questions')), describe())
    assert.match(done.body, /## Decisions the run made\n\n- May sub return a negative number\? \*\*Yes, return -2\*\*/)
    // Only the intent check was left: the reviewers and patch agents did not run again.
    assert.ok(modelCalls() - calls <= 2, `${modelCalls() - calls} model calls after resume`)

    const finished = await resume(7)
    assert.equal(finished.status, 202)
    assert.deepEqual(await finished.json(), { reason: 'the run is complete with PASS. Start a new run to try again', resumed: false, state: 'passed' })
    assert.deepEqual(await (await resume(8)).json(), { reason: 'there is no run. Start a run first', resumed: false, state: null })
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, /develop on an issue builds on the machine, opens a PR, runs the review loop there, takes its fixes, marks the PR ready, and merges it', { timeout: 300_000 }, async () => {
  const { repo } = developRepo({
    checks: { machine: 'test -f .setup-done' },
    merge: 'squash',
    setup: 'touch .setup-done',
    stack: 'TypeScript',
    tests: { command: 'env -u NODE_TEST_CONTEXT node --test {tests}', pattern: '\\.test\\.ts$' },
  })
  const issues = { 5: { body: 'Add sub and mul next to add, with tests.', title: 'Add sub and mul' } }
  const mock = await mockServices(repo, { botLogin: 'factory-bot', issues, name: 'app', owner: 'acme', script: developScript({ reviewFix: true }) })
  // FACTORY_CONTAINERS=1 runs the build machine as a real local container (it needs Docker). Else the mock is the machine.
  const containers = process.env.FACTORY_CONTAINERS === '1'
  // A budget of 100 s is below each turn time, so each alarm call stops before its next turn after new work, and the run
  // passes across several alarm calls. It leaves more than a minute for the commands of the builders (D12).
  const budget = { ...vars(mock), ALARM_BUDGET_SECONDS: '100' }
  const worker = await startFor(mock, containers ? budget : { ...budget, MACHINE_URL: `${mock.url}/machine` }, { containers })
  const on = (number: number) => mock.state.comments.filter((entry) => entry.issue === number)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
  try {
    const issueComment = { action: 'created', comment: { body: '/develop', user: { login: 'maintainer' } }, issue: { number: 5 }, repository }
    const started = (await (await sendWebhook(worker.url, secret, 'issue_comment', issueComment)).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    // The intake agent raised no user question, so the run takes its recommendations and does not ask on the issue (D11).
    const done = await until(() => on(5).find((entry) => entry.body.startsWith('# Development run:')), 240_000, describe)
    assert.match(done.body, /^# Development run: READY/, done.body)
    assert.match(done.body, /^- Alarm calls: [1-9]\d* planned stops?, \d+ crash restarts?$/m, done.body)
    assert.ok(!on(5).some((entry) => entry.body.includes('agent-factory:questions')), describe())
    assert.match(done.body, /## Decisions the run made\n\n- Is this the ask\? Correct it in your own words if it is not\. \*\*Yes, go on\*\*/)
    const [number, pull] = [...mock.state.pulls].find(([, entry]) => entry.head === 'factory/dev-add-sub-mul')!
    assert.equal(pull.draft, false)
    assert.match(pull.body, /# Ask\n\n> Add sub and mul/)
    assert.match(pull.body, /Closes #5/)
    const branch = 'refs/heads/factory/dev-add-sub-mul'
    assert.deepEqual([mock.fileAt(branch, 'src/sub.ts'), mock.fileAt(branch, 'src/mul.ts'), mock.fileAt(branch, 'test/run.log')], [sources.sub, sources.mul, null])
    // The review loop's fix is on the run's branch: the branch moved to the review's commit, without force.
    assert.equal(mock.fileAt(branch, 'test/ops.test.ts'), sources.test(6))
    assert.match(done.body, /- Pass 1: PASS, .*fixes merged from factory\/pr-\d+-/)

    // The builders ran the setup and the checks on the machine, in a copy of their branch.
    const commands = mock.state.commands.map((entry) => entry.argv.join(' '))
    if (!containers) assert.ok(commands.includes('bash -c touch .setup-done') && commands.includes('bash -c test -f .setup-done'), commands.join('\n'))
    const outputs = mock.state.turns.filter((turn) => turn.role === 'builder' && turn.output).map((turn) => turn.output).join('\n')
    assert.match(outputs, /checks: .*machine.*pass/)
    assert.match(outputs, /checkpoint refused:.*test\/run.log/)

    // The review loop ran as a review run of the new PR, and the report went to the PR and the issue.
    assert.ok(on(number).some((entry) => entry.body.startsWith('### agent-factory: PASS')), describe())
    assert.ok(on(number).some((entry) => entry.body.startsWith('# Development run: READY')))
    // Each run added the label of its kind: the development run to the issue, and the review run of the pass to the PR.
    assert.deepEqual([mock.state.labels.get(5), mock.state.labels.get(number)], [['agent-develop'], ['agent-review']])

    // With the standing permission, the host merged the PR at the head that the final CI checked. Then it deleted the run's branch, and the
    // prune deleted the review fix branch, whose fixes the run merged.
    assert.deepEqual(mock.state.merges.map(({ pr, method, sha }) => ({ pr, method, sha })), [{ method: 'squash', pr: number, sha: mock.state.refs.get(branch) }])
    const merged = `Merged by the host (squash): ${mock.state.merges[0]!.commit}.`
    assert.ok(done.body.includes(merged), done.body)
    assert.ok(on(number).some((entry) => entry.body.startsWith('# Development run: READY') && entry.body.includes(merged)))
    assert.equal(mock.state.deleted.length, 2, JSON.stringify(mock.state.deleted))
    assert.equal(mock.state.deleted[0], 'factory/dev-add-sub-mul')
    assert.match(mock.state.deleted[1]!, new RegExp(`^factory/pr-${number}-`))
    assert.match(done.body, new RegExp(`^- deleted factory/pr-${number}-\\S+ \\(applied\\)$`, 'm'))
    assert.deepEqual([mock.fileAt('refs/heads/main', 'src/sub.ts'), mock.fileAt('refs/heads/main', 'src/mul.ts')], [sources.sub, sources.mul])
    const status = (await (await fetch(`${worker.url}/runs/acme/app/5`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: { run: string; state: string }[] }
    assert.deepEqual(status.runs.map((run) => run.state), ['passed'])
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, /develop asks a user question of the intake agent on the issue, and the /answer webhook resumes the run', { timeout: 300_000 }, async () => {
  const { repo } = developRepo({
    checks: { machine: 'test -f .setup-done' },
    setup: 'touch .setup-done',
    stack: 'TypeScript',
    tests: { command: 'env -u NODE_TEST_CONTEXT node --test {tests}', pattern: '\\.test\\.ts$' },
  })
  const issues = { 5: { body: 'Add sub and mul next to add, with tests.', title: 'Add sub and mul' } }
  const mock = await mockServices(repo, { botLogin: 'factory-bot', issues, name: 'app', owner: 'acme', script: developScript({ askScope: true }) })
  const worker = await startFor(mock, { ...vars(mock), MACHINE_URL: `${mock.url}/machine` })
  const on = (number: number) => mock.state.comments.filter((entry) => entry.issue === number)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
  try {
    const issueComment = { action: 'created', comment: { body: '/develop', user: { login: 'maintainer' } }, issue: { number: 5 }, repository }
    const started = (await (await sendWebhook(worker.url, secret, 'issue_comment', issueComment)).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    // The scope question is a user question (D11), so the issue gets it with the confirmation of the ask, but not the route questions.
    const asked = await until(() => on(5).find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(asked.body, /\*\*Q1\.\*\* Add div too\?/)
    assert.match(asked.body, /\*\*Q2\.\*\* Is this the ask\?/)
    assert.doesNotMatch(asked.body, /Write a spec before the plan\?|How many review loop passes\?/)
    mock.comment('maintainer', '/answer recommended', 5)
    await sendWebhook(worker.url, secret, 'issue_comment', { ...issueComment, comment: { body: '/answer recommended', user: { login: 'maintainer' } } })

    const done = await until(() => on(5).find((entry) => entry.body.startsWith('# Development run:')), 240_000, describe)
    assert.match(done.body, /^# Development run: READY/, done.body)
    assert.equal(on(5).filter((entry) => entry.body.includes('agent-factory:questions')).length, 1, describe())
    assert.match(asked.body.split('\n')[0]!, /^@maintainer$/i)
    assert.doesNotMatch(done.body, /@Maintainer/i)
    assert.match(done.body, /^- \[x\] Ask confirmed: you answered the intake questions$/m)
    assert.match(done.body, /## Your decisions\n\n- Add div too\? \*\*No, only sub and mul\*\*.*\n- Is this the ask\? .*\*\*Yes, go on\*\*.*\n\n## Decisions the run made\n\n- Write a spec before the plan\? \*\*Plan now\*\*/)
  } finally {
    await worker.stop()
    await mock.close()
  }
})
