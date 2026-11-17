import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { mockServices } from './support/mock-services.ts'
import { notebook, pageText, researchConfig, researchScript } from './support/research.ts'
import { sendWebhook, startWorker, until } from './support/wrangler.ts'

const secret = 'webhook-secret'
const adminToken = 'admin-7f3k9q'
const repository = { full_name: 'acme/app' }
const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }
const free = { input: 0, cached_input: 0, cache_write: 0, output: 0 }
const program = { title: 'Quiet dwarf galaxies', body: 'Find quiet dwarf galaxies in the deep fields.' }
type Status = { runs: { run: string; state: string; note: string }[] }

// known waits for this file, so that it runs for longer than the alarm budget of 2 s, and across the restart.
const gate = join(mkdtempSync(join(tmpdir(), 'factory-gate-')), 'open')
const known = `while ! test -e '${gate}'; do sleep 0.2; done; ${researchConfig.commands.known}`

let mock: Awaited<ReturnType<typeof mockServices>>
let worker: Awaited<ReturnType<typeof startWorker>>
let vars: Record<string, string>
const describe = () => `jobs: ${JSON.stringify(mock.state.jobs.map((job) => [job.cwd, job.argv.join(' ').slice(-80)]))}\ncomments: ${JSON.stringify(mock.state.comments.map((c) => [c.issue, c.body.slice(0, 160)]))}\nworker:\n${worker.output().slice(-4000)}`
const status = async (number: number) => (await (await fetch(`${worker.url}/runs/acme/app/${number}`, { headers })).json()) as Status
const issuePayload = (number: number) => ({ number, ...(mock.state.pulls.has(number) ? { pull_request: {} } : {}) })
const knownStarts = () => mock.state.jobs.filter((job) => job.argv.join(' ').includes('research/run.mjs known'))

/** Answers each new question batch of the run and of its review pass: the pick of hyp-001, else the recommendations. */
const answered = new Set<number>()
async function answer() {
  for (const asked of mock.state.comments.filter((entry) => entry.user.login === 'factory-bot' && entry.body.includes('agent-factory:questions'))) {
    if (answered.has(asked.id)) continue
    answered.add(asked.id)
    const body = /batch=pick /.test(asked.body) ? '/answer\nQ1: a' : '/answer recommended'
    mock.comment('maintainer', body, asked.issue)
    await sendWebhook(worker.url, secret, 'issue_comment', { action: 'created', comment: { body, user: { login: 'maintainer' } }, issue: issuePayload(asked.issue), repository })
  }
}

before(async () => {
  const { repo } = notebook({ config: { checks: { smoke: 'true' }, research: { ...researchConfig, commands: { ...researchConfig.commands, known } } } })
  mock = await mockServices(repo, { botLogin: 'factory-bot', issues: { 5: program }, name: 'app', owner: 'acme', pages: pageText, script: researchScript() })
  vars = {
    ADMIN_TOKEN: adminToken,
    ALARM_BUDGET_SECONDS: '2',
    ALLOWED_USERS: 'Maintainer',
    ANTHROPIC_API_KEY: 'anthropic-key',
    ANTHROPIC_URL: `${mock.url}/v1/messages`,
    ARCHIVE_TOKEN: 'archive-token',
    EGRESS_URL: `${mock.url}/egress`,
    GITHUB_API_URL: mock.url,
    GITHUB_TOKEN: 'github-token',
    GITHUB_WEBHOOK_SECRET: secret,
    MACHINE_URL: `${mock.url}/machine`,
    MODEL_PRICES: JSON.stringify({ 'claude-opus-5-5': free, 'gpt-6.1-sol': free }),
    OPENAI_API_KEY: 'openai-key',
    OPENAI_URL: `${mock.url}/v1`,
    PAUSE_POLL_SECONDS: '1',
  }
  try {
    worker = await startWorker(vars)
  } catch (error) {
    await mock.close()
    throw error
  }
})

after(async () => {
  await worker?.stop()
  await mock?.close()
})

test('on Cloudflare, a domain command that runs longer than an alarm call pauses the run, lives through a Worker restart, and starts one time', { timeout: 600_000 }, async () => {
  const started = (await (await fetch(`${worker.url}/research/acme/app/5`, { body: '{}', headers, method: 'POST' })).json()) as { run: string; started: boolean }
  assert.equal(started.started, true)

  // The run pauses on the job of known, and each pause poll checks the job.
  const paused = await until(
    async () => {
      await answer()
      const latest = (await status(5)).runs[0]
      return latest?.state === 'paused' && /waiting for the job .*research\/run\.mjs known/.test(latest.note) ? latest : undefined
    },
    300_000,
    describe,
  )
  assert.match(paused.note, new RegExp(`in clean/${started.run}/`))
  const job = knownStarts()
  assert.equal(job.length, 1, describe())

  // A new Worker on the same Durable Object store polls the recorded job, and does not start known again.
  await worker.stop()
  const mark = mock.state.requests.length
  worker = await startWorker(vars, { persistTo: worker.persistTo })
  await fetch(`${worker.url}/runs/acme/app/5/resume`, { headers, method: 'POST' })
  await until(() => (mock.state.requests.slice(mark).includes('POST /machine/jobs/poll') ? true : undefined), 120_000, describe)
  assert.deepEqual(knownStarts(), job)

  writeFileSync(gate, '')
  const result = await until(
    async () => {
      await answer()
      return mock.state.comments.find((entry) => entry.issue === 5 && entry.body.startsWith('# Research run:'))
    },
    240_000,
    describe,
  )
  assert.match(result.body, /^# Research run: READY/, describe())
  assert.equal((await status(5)).runs[0]?.state, 'passed')
  // Each calibration round has a clean directory of its own, and known started one time in each.
  const dirs = knownStarts().map((entry) => entry.cwd)
  assert.equal(dirs[0], job[0]?.cwd)
  assert.deepEqual(dirs, [...new Set(dirs)], describe())
})
