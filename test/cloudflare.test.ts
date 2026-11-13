import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  ALLOWED_USERS: 'Eric',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_URL: `${mock.url}/v1/messages`,
  GITHUB_API_URL: mock.url,
  GITHUB_TOKEN: 'github-token',
  GITHUB_WEBHOOK_SECRET: secret,
  OPENAI_API_KEY: 'openai-key',
  OPENAI_URL: `${mock.url}/v1`,
  PAUSE_POLL_SECONDS: '2',
})
const comment = (login: string, body: string) => ({ action: 'created', comment: { body, user: { login } }, issue: { number: 7, pull_request: {} }, repository })

test('on Cloudflare, /review runs the loop in a Durable Object, asks on the PR, and pushes the fixes', { timeout: 240_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
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
    assert.match(done.body, /CI \(push\): pass/)
    assert.match(done.body, /May sub return a negative number\? \*\*No, throw an error\*\*/)
    assert.equal(mock.fileAt(`refs/heads/factory/${started.run}`, 'src/math.ts'), fixed)

    const status = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: { state: string }[] }
    assert.equal(status.runs[0]?.state, 'passed')
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`)).status, 401)
    const providers = new Set(mock.state.turns.filter((turn) => turn.role === 'late-minimize').map((turn) => turn.provider))
    assert.deepEqual(providers, new Set(['codex']))
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /Step 1 findings: host=0, minimize=1, rules=0, bugs=1, anti-slop=0/)
  } finally {
    worker.stop()
    mock.close()
  }
})

test('on Cloudflare, a fork PR stops before any work, because its fixes would run in this repository CI', { timeout: 120_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', headRepo: 'mallory/app', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
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

test('on Cloudflare, the admin route starts a run, and the run picks up the answer without the webhook', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startWorker(vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 120)))}`
  const admin = { authorization: 'Bearer admin', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(`${worker.url}/runs/acme/app/7`, { method: 'POST' })).status, 401)
    const started = (await (await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: admin, method: 'POST' })).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    const again = (await (await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin, method: 'POST' })).json()) as { run: string; started: boolean }
    assert.deepEqual(again, { run: started.run, started: false })

    await until(() => mock.state.comments.find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(mock.state.comments[0]!.body, /for @Eric/)
    mock.comment('eric', '/answer recommended')
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/)
    assert.match(done.body, /May sub return a negative number\? \*\*Yes, return -2\*\* \(recommended\)/)
  } finally {
    worker.stop()
    mock.close()
  }
})

test('on Cloudflare, a docs and tests only change takes the light loop, with host findings from the virtual git diff', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo({ light: true })
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startWorker(vars(mock))
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
    worker.stop()
    mock.close()
  }
})

test('on Cloudflare, deleted source files and the old paths of renamed source files require the full loop', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo({ light: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
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
    script: ({ role, output }) => {
      if (output !== null) return { text: 'done' }
      if (role === 'questions') return { cell: 'await tools.submit_questions({ questions: [] })' }
      if (role === 'intent') return { cell: 'await tools.submit_verdict({ satisfied: true, gaps: [], summary: "The change removes source files" })' }
      if (role === 'patch') return {
        cell: [
          `await tools.Write({ file_path: '/repo/docs/v2.md', content: ${JSON.stringify(lightFixed.docs)} })`,
          `await tools.Write({ file_path: '/repo/test/Vault.t.sol', content: ${JSON.stringify(lightFixed.test)} })`,
          'await tools.submit_patch_log({ applied: [{ id: "host-001", change: "wrote for example" }, { id: "host-002", change: "renamed the test" }], skipped: [] })',
        ].join('\n'),
      }
      return { cell: 'await tools.submit_findings({ findings: [] })' }
    },
  })
  const worker = await startWorker(vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { body: '{}', headers: { authorization: 'Bearer admin' }, method: 'POST' })
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    const report = await (await fetch(`${worker.url}/runs/acme/app/7/report`, { headers: { authorization: 'Bearer admin' } })).text()
    assert.match(report, /TRIAGE path=full reason=not-docs-or-tests files=[^\n`]*src\/math\.ts/)
    assert.match(report, /TRIAGE path=full reason=not-docs-or-tests files=[^\n`]*src\/removed\.ts/)
    assert.ok(mock.state.turns.some((turn) => turn.role === 'minimize'))
    assert.ok(!mock.state.turns.some((turn) => turn.role === 'light'))
  } finally {
    worker.stop()
    mock.close()
  }
})

test('on Cloudflare, a missing permission stops the run at once, and resume continues it from the ledger', { timeout: 180_000 }, async () => {
  const repo = fixtureRepo()
  const mock = await mockServices(repo, { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  mock.state.ciStatus = 403
  const worker = await startWorker(vars(mock))
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => c.body.slice(0, 160)))}`
  const admin = { authorization: 'Bearer admin' }
  const modelCalls = () => mock.state.requests.filter((route) => route.startsWith('POST /v1/')).length
  try {
    await fetch(`${worker.url}/runs/acme/app/7`, { headers: admin, method: 'POST' })
    await until(() => mock.state.comments.find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    mock.comment('eric', '/answer recommended')
    const stopped = await until(() => mock.state.comments.find((entry) => entry.body.includes('stopped run')), 120_000, describe)
    assert.match(stopped.body, /HTTP 403.* Check the permissions of GITHUB_TOKEN\. .*npm run remote -- resume acme\/app#7/)
    assert.equal(mock.state.requests.filter((route) => route.endsWith('/actions/runs')).length, 1)

    // The webhook path does not restart a stopped run. Only the admin route does.
    assert.deepEqual(await (await sendWebhook(worker.url, secret, 'issue_comment', comment('eric', '/answer recommended'))).json(), { resumed: false })
    const calls = modelCalls()
    mock.state.ciStatus = 200
    const resume = (pr: number) => fetch(`${worker.url}/runs/acme/app/${pr}/resume`, { headers: admin, method: 'POST' })
    assert.deepEqual(await (await resume(7)).json(), { reason: 'started the run again from its ledger after the error', resumed: true, state: 'error' })
    const done = await until(() => mock.state.comments.find((entry) => entry.body.startsWith('### agent-factory:')), 120_000, describe)
    assert.match(done.body, /agent-factory: PASS/)
    // Only the intent check was left: the reviewers and patch agents did not run again.
    assert.ok(modelCalls() - calls <= 2, `${modelCalls() - calls} model calls after resume`)

    const finished = await resume(7)
    assert.equal(finished.status, 202)
    assert.deepEqual(await finished.json(), { reason: 'the run is complete with PASS. Start a new run to try again', resumed: false, state: 'passed' })
    assert.deepEqual(await (await resume(8)).json(), { reason: 'there is no run. Start a run first', resumed: false, state: null })
  } finally {
    worker.stop()
    mock.close()
  }
})

for (const ciEvent of ['workflow_run', 'empty_workflow_run', 'status'] as const) {
  test(`on Cloudflare, /develop on an issue builds on the machine, opens a PR, runs the review loop there, takes its fixes, and marks the PR ready (${ciEvent})`, { timeout: 300_000 }, () => developmentWakeup(ciEvent))
}

async function developmentWakeup(ciEvent: 'workflow_run' | 'empty_workflow_run' | 'status') {
  const { repo } = developRepo({
    checks: { machine: 'test -f .setup-done' },
    setup: 'touch .setup-done',
    stack: 'TypeScript',
    tests: { command: 'env -u NODE_TEST_CONTEXT node --test {tests}', pattern: '\\.test\\.ts$' },
  })
  const issues = { 5: { body: 'Add sub and mul next to add, with tests.', title: 'Add sub and mul' } }
  const mock = await mockServices(repo, { botLogin: 'factory-bot', issues, name: 'app', owner: 'acme', script: developScript({ reviewFix: true }) })
  mock.state.ciPending = true
  // FACTORY_CONTAINERS=1 runs the build machine as a real local container (it needs Docker). Else the mock is the machine.
  const containers = process.env.FACTORY_CONTAINERS === '1'
  const bindings = { ...vars(mock), PAUSE_POLL_SECONDS: '3600' }
  const worker = await startWorker(containers ? bindings : { ...bindings, MACHINE_URL: `${mock.url}/machine` }, { containers })
  const on = (number: number) => mock.state.comments.filter((entry) => entry.issue === number)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
  const status = async () => (await (await fetch(`${worker.url}/runs/acme/app/5`, { headers: { authorization: 'Bearer admin' } })).json()) as { runs: { run: string; state: string; note: string }[] }
  try {
    const refused = await fetch(`${worker.url}/develop/acme/app/5`, {
      method: 'POST', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify({ parallel: 0 }),
    })
    assert.equal(refused.status, 400)
    assert.match(await refused.text(), /--parallel must be an integer of 1 or more/)
    assert.deepEqual((await status()).runs, [])
    assert.equal(mock.state.turns.length, 0)

    // An invalid comment option uses the default and does not stop the run without a comment.
    const issueComment = { action: 'created', comment: { body: '/develop --parallel two', user: { login: 'eric' } }, issue: { number: 5 }, repository }
    const started = (await (await sendWebhook(worker.url, secret, 'issue_comment', issueComment)).json()) as { run: string; started: boolean }
    assert.equal(started.started, true)
    const asked = await until(() => on(5).find((entry) => entry.body.includes('agent-factory:questions')), 120_000, describe)
    assert.match(asked.body, /Is this the ask\?/)
    await until(async () => (await status()).runs.find((run) => run.state === 'paused'), 30_000, describe)
    mock.comment('eric', '/answer recommended', 5)
    await sendWebhook(worker.url, secret, 'issue_comment', { ...issueComment, comment: { body: '/answer recommended', user: { login: 'eric' } } })

    await until(async () => (await status()).runs.find((run) => run.state === 'paused' && run.note.startsWith('waiting for CI')), 120_000, describe)
    const opened = [...mock.state.pulls].find(([, entry]) => entry.head === 'factory/dev-add-sub-mul')
    assert.ok(opened, describe())
    mock.state.ciPending = false
    const payload = ciEvent === 'status'
      ? { branches: [{ name: opened[1].head }], repository, state: 'success' }
      : { action: 'completed', repository, workflow_run: { head_branch: opened[1].head, pull_requests: ciEvent === 'workflow_run' ? [{ number: opened[0] }] : [] } }
    const woke = await sendWebhook(worker.url, secret, ciEvent === 'status' ? 'status' : 'workflow_run', payload)
    assert.deepEqual(await woke.json(), { woke: [opened[0]] })

    // CI and the end of the review must wake this run before its one-hour poll.
    const done = await until(() => on(5).find((entry) => entry.body.startsWith('# Development run:')), 240_000, describe)
    assert.match(done.body, /^# Development run: READY/, done.body)
    const [number, pull] = [...mock.state.pulls].find(([, entry]) => entry.head === 'factory/dev-add-sub-mul')!
    assert.equal(pull.draft, false)
    assert.match(pull.body, /# Ask\n\n> Add sub and mul/)
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
    assert.deepEqual((await status()).runs.map((run) => run.state), ['passed'])
  } finally {
    worker.stop()
    mock.close()
  }
}
