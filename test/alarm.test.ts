import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { crashRestartsKey, PlannedStop, plannedStopsKey } from '../src/core/planned-stop.ts'
import { PausedError } from '../src/core/questions.ts'
import { StopError } from '../src/core/stop.ts'
import { afterError, alarmBudgetMs, countRestart, initCounters, maxErrorRestarts, maxRestarts, preflightKey, progressLedger, restartAtKey } from '../src/cloudflare/alarm.ts'
import { GitHubError } from '../src/cloudflare/github.ts'

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, value) }
}

const options = { now: 1_000, pauseSeconds: undefined }

test('a planned stop queues the run with the next alarm now, counts the stop, and keeps attempts and restarts', () => {
  const ledger = progressLedger(memoryLedger())
  initCounters(ledger)
  ledger.put('attempts', 1)
  ledger.put('restarts', 2)
  const outcome = afterError(ledger, new PlannedStop('the call used 3 s of its budget of 2 s'), options)
  assert.deepEqual(outcome, { state: 'queued', note: 'the call used 3 s of its budget of 2 s. The run continues in the next alarm call.', next: 1_000, attempts: null, restart: null })
  assert.deepEqual([ledger.get(plannedStopsKey), ledger.get('attempts'), ledger.get('restarts'), ledger.get(crashRestartsKey)], [1, 1, 2, 0])
  afterError(ledger, new PlannedStop('again'), options)
  assert.equal(ledger.get(plannedStopsKey), 2)
})

test('a pause and other errors keep their behavior', () => {
  const ledger = memoryLedger()
  ledger.put('attempts', 1)
  assert.deepEqual(afterError(ledger, new PausedError('waiting for CI'), { now: 1_000, pauseSeconds: '2' }), { state: 'paused', note: 'waiting for CI', next: 3_000, attempts: null, restart: null })
  assert.equal(ledger.get('attempts'), 0)
  assert.equal(afterError(ledger, new PausedError('waiting'), options).next, 61_000)
  assert.deepEqual(afterError(ledger, new Error('flaky'), options), { state: 'queued', note: 'attempt 1 failed: flaky', next: 61_000, attempts: 1, restart: null })
  ledger.put('attempts', 0)
  assert.deepEqual(afterError(ledger, new StopError('no token'), options), { state: 'error', note: 'no token', next: null, attempts: 1, restart: null })
  assert.deepEqual(afterError(ledger, new GitHubError(403, 'Resource not accessible by integration'), options), {
    state: 'error',
    note: 'Resource not accessible by integration',
    next: null,
    attempts: 2,
    restart: null,
  })
  assert.equal(ledger.get(plannedStopsKey), undefined)
})

test('an error after three attempts, or a crash loop, starts the run again from its ledger after 30 minutes, at most three times (D13)', () => {
  const ledger = progressLedger(memoryLedger())
  initCounters(ledger)
  ledger.put('job-starts', 1)
  const restartAt = 1_000 + 30 * 60_000
  afterError(ledger, new Error('flaky'), options)
  afterError(ledger, new Error('flaky'), options)
  ledger.put('restarts', 2)
  assert.deepEqual(afterError(ledger, new Error('flaky'), options), {
    state: 'queued',
    note: `flaky. The host starts the run again from its ledger at ${new Date(restartAt).toISOString()} (restart 1 of 3)`,
    next: restartAt,
    attempts: 3,
    restart: 1,
  })
  // As the admin resume: new attempts and crash restarts.
  assert.deepEqual([ledger.get('attempts'), ledger.get('restarts'), ledger.get(restartAtKey)], [0, 0, restartAt])
  // A crash loop goes to the next restart at once, without three attempts.
  for (let n = 0; n <= maxRestarts; n++) {
    try {
      countRestart(ledger)
    } catch (error) {
      assert.equal(afterError(ledger, error, options).restart, 2)
    }
  }
  assert.equal(afterError(ledger, new StopError('the run waits for CI', { transient: true }), options).restart, 3)
  const last = afterError(ledger, new StopError('the run waits for CI', { transient: true }), options)
  assert.deepEqual(last, { state: 'error', note: `the run waits for CI. The run stopped again after ${maxErrorRestarts} restarts`, next: null, attempts: 1, restart: null })
  // A finished step is progress, so the next error gets new restarts.
  ledger.put('step:calibrate', { ok: true })
  assert.equal(afterError(ledger, new StopError('the run waits for CI', { transient: true }), options).restart, 1)
})

test('a D13 restart clears the preflight flag, so that the restart runs the preflight again, and a planned stop or a pause keeps it (D17)', () => {
  const ledger = progressLedger(memoryLedger())
  ledger.put(preflightKey, true)
  afterError(ledger, new PlannedStop('stop'), options)
  afterError(ledger, new PausedError('waiting for CI'), options)
  afterError(ledger, new Error('flaky'), options)
  assert.equal(ledger.get(preflightKey), true)
  afterError(ledger, new Error('flaky'), options)
  assert.equal(afterError(ledger, new Error('flaky'), options).restart, 1)
  assert.equal(ledger.get(preflightKey), false)
})

test('a crash adds to restarts and crash-restarts, and stops past maxRestarts', () => {
  const ledger = progressLedger(memoryLedger())
  initCounters(ledger)
  for (let n = 1; n <= maxRestarts; n++) countRestart(ledger)
  assert.deepEqual([ledger.get('restarts'), ledger.get(crashRestartsKey)], [maxRestarts, maxRestarts])
  assert.throws(() => countRestart(ledger), StopError)
  assert.deepEqual([ledger.get('restarts'), ledger.get(crashRestartsKey)], [maxRestarts + 1, maxRestarts + 1])
})

test('a finished step resets attempts and restarts, but not the counters', () => {
  const ledger = progressLedger(memoryLedger())
  initCounters(ledger)
  ledger.put('attempts', 2)
  countRestart(ledger)
  afterError(ledger, new PlannedStop('stop'), options)
  ledger.put('step:plan', { ok: true })
  assert.deepEqual([ledger.get('attempts'), ledger.get('restarts'), ledger.get(crashRestartsKey), ledger.get(plannedStopsKey)], [0, 0, 1, 1])
})

test('initCounters sets absent counters to 0 and keeps present ones', () => {
  const ledger = memoryLedger()
  ledger.put(plannedStopsKey, 3)
  initCounters(ledger)
  assert.deepEqual([ledger.get(plannedStopsKey), ledger.get(crashRestartsKey)], [3, 0])
})

test('alarmBudgetMs parses ALARM_BUDGET_SECONDS, and falls back to 780 s for a value that is not valid', () => {
  for (const value of [undefined, '', 'abc', '0', '-5']) assert.equal(alarmBudgetMs(value), 780_000, String(value))
  assert.equal(alarmBudgetMs('2'), 2_000)
})
