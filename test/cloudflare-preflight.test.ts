import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixtureRepo, scriptFor } from './support/fixture.ts'
import { mockServices } from './support/mock-services.ts'
import { startWorker, until } from './support/wrangler.ts'

const admin = { authorization: 'Bearer admin' }
const vars = (mock: { url: string }) => ({
  ADMIN_TOKEN: 'admin',
  ALLOWED_USERS: 'Maintainer',
  ANTHROPIC_API_KEY: 'anthropic-key',
  ANTHROPIC_URL: `${mock.url}/v1/messages`,
  GITHUB_API_URL: mock.url,
  GITHUB_TOKEN: 'github-token',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  MACHINE_URL: `${mock.url}/machine`,
  OPENAI_API_KEY: 'openai-key',
  OPENAI_URL: `${mock.url}/v1`,
  PAUSE_POLL_SECONDS: '2',
})
type Mock = Awaited<ReturnType<typeof mockServices>>
type Worker = Awaited<ReturnType<typeof startWorker>>

/** Starts the Worker, and closes the mock when wrangler dev does not start. */
async function startFor(mock: Mock, workerVars: Record<string, string>) {
  try {
    return await startWorker(workerVars)
  } catch (error) {
    await mock.close()
    throw error
  }
}

/**
 * Starts a review run on the PR and waits for its preflight comment. Checks that the PR has only the status comment and
 * this comment, that no agent turn ran, and that the run waits with error.
 */
async function failedPreflight(mock: Mock, worker: Worker, pr: number): Promise<string> {
  const on = () => mock.state.comments.filter((entry) => entry.issue === pr)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 300)]))}\nworker:\n${worker.output().slice(-3000)}`
  await fetch(`${worker.url}/runs/acme/app/${pr}`, { body: '{}', headers: admin, method: 'POST' })
  const failed = await until(() => on().find((entry) => entry.body.includes('did not start run')), 60_000, describe)
  assert.match(failed.body, new RegExp(`^agent-factory did not start run \`pr-${pr}-[^\`]+\`: the preflight found failed checks\\.\n\n<details><summary>Failed checks</summary>\n\n- \\*\\*`))
  assert.match(failed.body, /\n\n<\/details>\n\nAfter you fix them/)
  assert.match(failed.body, new RegExp(`After you fix them, continue the run with \`npm run remote -- resume acme/app#${pr}\`\\.$`))
  assert.equal(on().length, 2, describe())
  assert.match(on()[0]!.body, new RegExp(`^<!-- agent-factory:status run=pr-${pr}-[^ ]+ -->\n[\\s\\S]*\\*\\*State:\\*\\* stopped: the preflight found failed checks`), describe())
  assert.equal(mock.state.turns.length, 0, describe())
  const status = (await (await fetch(`${worker.url}/runs/acme/app/${pr}`, { headers: admin })).json()) as { runs: { state: string; note: string }[] }
  assert.equal(status.runs[0]?.state, 'error')
  assert.match(status.runs[0]?.note ?? '', /^the preflight found failed checks: /)
  return failed.body
}

test('on Cloudflare, a run without ANTHROPIC_API_KEY fails the preflight with one comment, and probes only the other provider', { timeout: 120_000 }, async () => {
  const mock = await mockServices(fixtureRepo(), { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ tests: false }) })
  const worker = await startFor(mock, Object.fromEntries(Object.entries(vars(mock)).filter(([name]) => name !== 'ANTHROPIC_API_KEY')))
  try {
    const body = await failedPreflight(mock, worker, 7)
    assert.match(body, /- \*\*Provider key \(claude\)\*\*: Claude models need ANTHROPIC_API_KEY\. Fix: set ANTHROPIC_API_KEY as a Worker secret/)
    assert.deepEqual(mock.state.probes.map((probe) => probe.provider), ['codex'])
  } finally {
    await worker.stop()
    await mock.close()
  }
})

test('on Cloudflare, a review without a workflow file and a refused probe each fail the preflight, and the admin resume after the fix runs the review', { timeout: 300_000 }, async () => {
  const mock = await mockServices(fixtureRepo(), { botLogin: 'factory-bot', name: 'app', owner: 'acme', pr: 7, script: scriptFor({ runQuestion: true, tests: false }) })
  const worker = await startFor(mock, vars(mock))
  const on = (pr: number) => mock.state.comments.filter((entry) => entry.issue === pr)
  const describe = () => `comments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-3000)}`
  try {
    // A second PR on the same base, so that this Worker also checks the CI workflow alone.
    mock.state.pulls.set(8, { body: 'Add sub.', draft: false, head: 'feature', title: 'Add sub' })
    mock.state.workflows = false
    const noWorkflow = await failedPreflight(mock, worker, 8)
    assert.match(noWorkflow, /- \*\*CI workflow\*\*: main has no workflow file in \.github\/workflows\. Fix: add a workflow file to \.github\/workflows on main/)
    mock.state.workflows = true

    mock.state.probeReply.claude = { body: { error: { message: 'Your credit balance is too low to access the Anthropic API.', type: 'invalid_request_error' }, type: 'error' }, status: 400 }
    const refused = await failedPreflight(mock, worker, 7)
    assert.match(refused, /- \*\*Provider key \(claude\)\*\*: the claude account has no credit or quota \(HTTP 400: .*credit balance is too low.*\)\. Fix: check ANTHROPIC_API_KEY/)
    assert.doesNotMatch(refused, /CI workflow|Build container|GitHub access/)

    // After the fix, the admin resume runs the preflight again, and the run starts and finishes.
    mock.state.probeReply.claude = { body: {}, status: 200 }
    const probes = mock.state.probes.length
    const resumed = await fetch(`${worker.url}/runs/acme/app/7/resume`, { headers: admin, method: 'POST' })
    assert.deepEqual(await resumed.json(), { reason: 'started the run again from its ledger after the error', resumed: true, state: 'error' })
    const done = await until(() => on(7).find((entry) => /^### agent-factory:/m.test(entry.body)), 150_000, describe)
    assert.match(done.body, /agent-factory: PASS/, done.body)
    assert.deepEqual(new Set(mock.state.probes.slice(probes).map((probe) => probe.provider)), new Set(['claude', 'codex']))
    assert.equal(on(7).filter((entry) => entry.body.startsWith('<!-- agent-factory:status run=pr-7-')).length, 1, describe())
    assert.equal(on(7).filter((entry) => entry.body.includes('did not start run')).length, 1, describe())
  } finally {
    await worker.stop()
    await mock.close()
  }
})
