import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ledger } from '../src/core/ledger.ts'
import { crashRestartsKey, PlannedStop, plannedStopsKey } from '../src/core/planned-stop.ts'
import { PausedError } from '../src/core/questions.ts'
import { StopError } from '../src/core/stop.ts'
import { afterError, alarmBudgetMs, countRestart, initCounters, maxRestarts, progressLedger } from '../src/cloudflare/alarm.ts'

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
  assert.deepEqual(outcome, { state: 'queued', note: 'the call used 3 s of its budget of 2 s. The run continues in the next alarm call.', next: 1_000, attempts: null })
  assert.deepEqual([ledger.get(plannedStopsKey), ledger.get('attempts'), ledger.get('restarts'), ledger.get(crashRestartsKey)], [1, 1, 2, 0])
  afterError(ledger, new PlannedStop('again'), options)
  assert.equal(ledger.get(plannedStopsKey), 2)
})

test('a pause and other errors keep their behavior', () => {
  const ledger = memoryLedger()
  ledger.put('attempts', 1)
  assert.deepEqual(afterError(ledger, new PausedError('waiting for CI'), { now: 1_000, pauseSeconds: '2' }), { state: 'paused', note: 'waiting for CI', next: 3_000, attempts: null })
  assert.equal(ledger.get('attempts'), 0)
  assert.equal(afterError(ledger, new PausedError('waiting'), options).next, 61_000)
  assert.deepEqual(afterError(ledger, new Error('flaky'), options), { state: 'queued', note: 'attempt 1 failed: flaky', next: 61_000, attempts: 1 })
  afterError(ledger, new Error('flaky'), options)
  assert.deepEqual(afterError(ledger, new Error('flaky'), options), { state: 'error', note: 'flaky', next: null, attempts: 3 })
  ledger.put('attempts', 0)
  assert.deepEqual(afterError(ledger, new StopError('no token'), options), { state: 'error', note: 'no token', next: null, attempts: 1 })
  assert.equal(ledger.get(plannedStopsKey), undefined)
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

test('alarmBudgetMs parses ALARM_BUDGET_SECONDS, and falls back to 480 s for a value that is not valid', () => {
  for (const value of [undefined, '', 'abc', '0', '-5']) assert.equal(alarmBudgetMs(value), 480_000, String(value))
  assert.equal(alarmBudgetMs('2'), 2_000)
})
