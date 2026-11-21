import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { PausedError } from '../src/core/questions.ts'
import { StopError } from '../src/core/stop.ts'
import { zeroTokens } from '../src/core/usage.ts'
import type { LoopResult } from '../src/core/workflows/code-review-loop.ts'
import { afterError, maxErrorRestarts, progressLedger } from '../src/cloudflare/alarm.ts'
import { reviewPass, type ReviewRuns } from '../src/cloudflare/review.ts'

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, value) }
}

const options = { now: 1_000, pauseSeconds: undefined }
const note = 'step1.patch.1 did not call submit_patch_log'
const passed: LoopResult = { branch: 'factory/pr-9-1', criteria: [], final: 'abc', pass: true, report: 'PASS', stopped: false, usage: { tokens: zeroTokens(), unpriced: [], usd: 0 } }
const request = { by: 'maintainer', owner: 'acme', repo: 'app' }
const review = { ask: 'Add sub', branch: 'factory/dev-1', full: false, head: 'abc', pr: 9, runId: 'dev-1-review-1' }

/** A parent run with one review run, as PULL_REQUESTS gives it. The fake review run goes to `queued` on a resume. */
function parent() {
  const fake = { state: 'running', refuse: false, resumes: 0, starts: 0 }
  const runs: ReviewRuns = {
    async start() {
      fake.starts++
      return { run: 'pr-9-1' }
    },
    async outcome(run) {
      if (fake.state === 'error') return { error: note }
      if (fake.state === 'passed') return passed
      return { waiting: `review run ${run} is ${fake.state}` }
    },
    async resumeAfterError(run) {
      fake.resumes++
      if (fake.refuse) return { reason: 'review run pr-9-2 of this PR is running', resumed: false }
      fake.state = 'queued'
      return { reason: `started review run ${run} again from its ledger after the error`, resumed: true }
    },
  }
  const env = { PULL_REQUESTS: { idFromName: (name: string) => name, get: () => runs } }
  const ledger = progressLedger(memoryLedger())
  /** One alarm call of the parent: the error that reviewPass threw, and what afterError made of it. */
  const call = async () => {
    try {
      return { result: await reviewPass(env, request, ledger, review) }
    } catch (error) {
      return { error, outcome: afterError(ledger, error, options) }
    }
  }
  return { call, fake, ledger }
}

test('a review run in error stops its parent with a transient error, each D13 restart resumes it, and the admin resume after the third restart resumes it again', async () => {
  const { call, fake } = parent()
  fake.state = 'error'
  const first = await call()
  assert.ok(first.error instanceof StopError && first.error.transient)
  assert.match(first.error.message, new RegExp(note))
  assert.equal(first.outcome?.restart, 1)
  assert.equal(first.outcome?.state, 'queued')
  for (let restart = 1; restart <= maxErrorRestarts; restart++) {
    const resumed = await call()
    assert.ok(resumed.error instanceof PausedError)
    assert.equal(resumed.outcome?.state, 'paused')
    assert.equal(fake.resumes, restart)
    fake.state = 'error'
    const again = await call()
    assert.ok(again.error instanceof StopError && again.error.transient)
    assert.equal(fake.resumes, restart)
    if (restart < maxErrorRestarts) assert.equal(again.outcome?.restart, restart + 1)
    else assert.deepEqual([again.outcome?.state, again.outcome?.restart], ['error', null])
  }
  assert.equal(fake.resumes, maxErrorRestarts)
  // As after the admin resume of the parent.
  const resumed = await call()
  assert.ok(resumed.error instanceof PausedError)
  assert.equal(fake.resumes, maxErrorRestarts + 1)
  fake.state = 'passed'
  assert.deepEqual((await call()).result, passed)
  assert.equal(fake.starts, 1)
})

test('a review run that is queued, running or paused pauses its parent without a resume, and clears an earlier error record', async () => {
  for (const state of ['queued', 'running', 'paused']) {
    const { call, fake, ledger } = parent()
    ledger.put(`review-error:${review.runId}`, true)
    fake.state = state
    const paused = await call()
    assert.ok(paused.error instanceof PausedError)
    assert.equal(paused.error.message, `review run pr-9-1 is ${state}`)
    assert.equal(fake.resumes, 0)
    // The record is cleared, so a later error counts as a D13 restart and does not resume at once.
    fake.state = 'error'
    const stopped = await call()
    assert.ok(stopped.error instanceof StopError)
    assert.equal(fake.resumes, 0)
  }
})

test('a refused resume of a review run in error counts as a D13 restart, keeps the error record, and the parent waits with error after the third restart', async () => {
  const { call, fake } = parent()
  fake.state = 'error'
  assert.equal((await call()).outcome?.restart, 1)
  fake.refuse = true
  for (let poll = 1; poll <= maxErrorRestarts; poll++) {
    const refused = await call()
    assert.ok(refused.error instanceof StopError && refused.error.transient)
    assert.match(refused.error.message, /review run pr-9-2 of this PR is running/)
    assert.equal(fake.resumes, poll)
    if (poll < maxErrorRestarts) assert.equal(refused.outcome?.restart, poll + 1)
    else assert.deepEqual([refused.outcome?.state, refused.outcome?.restart], ['error', null])
  }
  // As after the admin resume of the parent.
  fake.refuse = false
  const resumed = await call()
  assert.ok(resumed.error instanceof PausedError)
  assert.equal(fake.state, 'queued')
  assert.equal(fake.resumes, maxErrorRestarts + 1)
})
