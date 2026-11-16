import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import type { Ledger } from '../src/core/ledger.ts'
import { decisions, parseAnswers, PausedError, type Channel, type Question } from '../src/core/questions.ts'
import { StopError } from '../src/core/stop.ts'
import {
  budgetGate,
  BudgetStop,
  checkPriced,
  costOf,
  parseBudget,
  parsePrices,
  recordUsage,
  resolveBudget,
  runUsage,
  spendOf,
  usageOf,
  usageSection,
  type Prices,
} from '../src/core/usage.ts'
import { fileLedger } from '../src/node/ledger.ts'

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, structuredClone(value)) }
}

/** A channel that answers each batch from `replies`. A batch without a reply has no answer yet. */
function scriptedChannel(replies: Record<string, string> = {}) {
  const posted: { batch: string; questions: Question[] }[] = []
  const channel: Channel = {
    async post(_runId, batch, questions) {
      posted.push({ batch, questions })
      return { batch, ref: `memory:${batch}`, at: new Date().toISOString() }
    },
    async answers(where, questions) {
      const reply = replies[where.batch]
      return reply === undefined ? null : parseAnswers(reply, questions)
    },
    where: (where) => where.ref,
  }
  return { channel, posted, replies }
}

/** A model.call.completed event as the SDK publishes it: the usage sits in the payload of the inner event. */
const call = (run: string, seq: number, usage?: unknown, replayed = false): Contracts.LoggedEvent => ({
  seq: 0,
  request_id: 'task',
  created_at: 0,
  event: { source: 'agent', event: { request_id: run, seq, type: 'model.call.completed', payload: { usage, timing: { replayed } } } },
})

const toolCall: Contracts.LoggedEvent = { seq: 0, request_id: 'task', created_at: 0, event: { source: 'agent', event: { request_id: 'r1', seq: 3, type: 'tool.call', payload: {} } } }

const price = { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }

test('MODEL_PRICES needs all four non-negative prices of each model', () => {
  assert.deepEqual(parsePrices(JSON.stringify({ m1: price })), { m1: price })
  assert.deepEqual(parsePrices(undefined), {})
  assert.deepEqual(parsePrices('  '), {})
  assert.throws(() => parsePrices('{m1:'), (error) => error instanceof StopError && /not valid JSON/.test(error.message))
  assert.throws(() => parsePrices('[]'), StopError)
  assert.throws(() => parsePrices(JSON.stringify({ m1: { input: 3, cached_input: 0.3, output: 15 } })), /m1\.cache_write/)
  assert.throws(() => parsePrices(JSON.stringify({ m1: { ...price, output: -1 } })), /m1\.output must be a non-negative number/)
  assert.throws(() => parsePrices(JSON.stringify({ m1: { ...price, input: '3' } })), /m1\.input/)
})

test('a budget must be a positive number of USD', () => {
  assert.equal(parseBudget(5), 5)
  assert.equal(parseBudget('2.5'), 2.5)
  for (const value of [0, -1, 'abc', '', Number.NaN, Number.POSITIVE_INFINITY, null])
    assert.throws(() => parseBudget(value), (error) => error instanceof StopError && /budget must be a positive number of USD/.test(error.message))
})

test('checkPriced names each model without a price one time', () => {
  checkPriced(['m1', 'm1'], { m1: price })
  assert.throws(() => checkPriced(['m1', 'm2', 'm3', 'm2'], { m1: price }), (error) => error instanceof StopError && /no price for: m2, m3$/.test(error.message))
})

test('costOf bills the input without the cached and cache-write tokens at the input price', () => {
  const usd = costOf({ input: 1000, cached: 300, cache_write: 100, output: 50 }, price)
  assert.ok(Math.abs(usd - (600 * 3 + 300 * 0.3 + 100 * 3.75 + 50 * 15) / 1e6) < 1e-15)
})

test('recordUsage sums each agent and the run, counts missing fields as zero, and counts each event one time', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-usage-')), 'state.json')
  const first = [
    call('r1', 1, { input_tokens: 100, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 }, output_tokens: 20 }),
    toolCall,
    call('r1', 2),
    // A subagent run of the same agent.
    call('r2', 1, { input_tokens: 5, input_tokens_details: null }),
  ]
  const other = [call('r3', 1, { input_tokens: 7, output_tokens: 3 })]
  const expected = {
    agents: [
      { id: 'a', model: 'm1', tokens: { input: 105, cached: 40, cache_write: 10, output: 20 } },
      { id: 'b', model: 'm2', tokens: { input: 7, cached: 0, cache_write: 0, output: 3 } },
    ],
    total: { input: 112, cached: 40, cache_write: 10, output: 23 },
  }
  const ledger = fileLedger(path)
  recordUsage(ledger, 'a', 'm1', first)
  recordUsage(ledger, 'b', 'm2', other)
  assert.deepEqual(usageOf(ledger), expected)

  // The same events again, as after a reconnect, and a replayed call from the journal.
  recordUsage(ledger, 'a', 'm1', first)
  recordUsage(ledger, 'a', 'm1', [call('r1', 4, { input_tokens: 100, output_tokens: 20 }, true)])
  assert.deepEqual(usageOf(ledger), expected)

  // A resumed run reads the same state file into a new ledger.
  const resumed = fileLedger(path)
  recordUsage(resumed, 'a', 'm1', first)
  recordUsage(resumed, 'b', 'm2', other)
  assert.deepEqual(usageOf(resumed), expected)

  recordUsage(resumed, 'b', 'm2', [call('r3', 2, { input_tokens: 1, output_tokens: 1 })])
  assert.deepEqual(usageOf(resumed).total, { input: 113, cached: 40, cache_write: 10, output: 24 })
})

test('the Usage section shows each step, no price, a precomputed row, the total and the budget', () => {
  const ledger = memoryLedger()
  recordUsage(ledger, 'a', 'm1', [call('r1', 1, { input_tokens: 1000, output_tokens: 100 })])
  recordUsage(ledger, 'b', 'm2', [call('r2', 1, { input_tokens: 10, output_tokens: 1 })])
  const prices: Prices = { m1: price }
  const spend = spendOf(ledger, prices)
  assert.deepEqual(spend.unpriced, ['m2'])
  assert.ok(Math.abs(spend.usd - 0.0045) < 1e-12)
  assert.deepEqual(runUsage(ledger, prices), { tokens: { input: 1010, cached: 0, cache_write: 0, output: 101 }, ...spend })

  const rows = [
    ...usageOf(ledger).agents.map((agent) => ({ step: agent.id, model: agent.model, tokens: agent.tokens })),
    { step: 'review.1', model: 'several', tokens: { input: 1, cached: 0, cache_write: 0, output: 1 }, usd: 2, unpriced: ['m3'] },
  ]
  const section = usageSection(rows, prices, { limit: 5, spent: 2.0045 }).join('\n')
  assert.match(section, /^## Usage/)
  assert.match(section, /\| a \| m1 \| 1000 \| 0 \| 0 \| 100 \| \$0\.0045 \|/)
  assert.match(section, /\| b \| m2 \| 10 \| 0 \| 0 \| 1 \| no price \|/)
  assert.match(section, /\| review\.1 \| several \| 1 \| 0 \| 0 \| 1 \| \$2\.00 \(no price: m3\) \|/)
  assert.match(section, /\| \*\*Total\*\* \| {2}\| 1011 \| 0 \| 0 \| 102 \| \$2\.00 \(2 models without a price\) \|/)
  assert.match(section, /Budget: \$5\.00\. Spent: \$2\.00\./)
  assert.doesNotMatch(usageSection(rows, prices).join('\n'), /Budget/)
})

/** A ledger with a spend of $10: one agent with 10 input tokens at $1 each. */
function spentTen() {
  const ledger = memoryLedger()
  recordUsage(ledger, 'a', 'm1', [call('r1', 1, { input_tokens: 10 })])
  const prices: Prices = { m1: { input: 1e6, cached_input: 0, cache_write: 0, output: 0 } }
  const { channel, posted, replies } = scriptedChannel()
  const gate = (options: { extraSpend?: () => number; recommend?: boolean } = {}) =>
    budgetGate({ ledger, channel, runId: 'run-1', prices, log: () => {}, ...options })
  return { ledger, posted, replies, gate }
}

test('without a budget or under it, the gate asks nothing', async () => {
  const { ledger, posted, gate } = spentTen()
  await gate().check()
  assert.equal(gate().limit(), undefined)
  assert.equal(resolveBudget(ledger, 20), 20)
  await gate().check()
  assert.equal(gate().spent(), 10)
  assert.equal(posted.length, 0)
})

test('at the budget, concurrent checks post one question and pause; a higher number raises the budget', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  resolveBudget(ledger, 10)
  const one = gate()
  const checks = [one.check(), one.check(), one.check()]
  assert.equal(checks[0], checks[1])
  const results = await Promise.allSettled(checks)
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof PausedError))
  assert.equal(posted.length, 1)
  const [question] = posted[0]!.questions
  assert.match(posted[0]!.batch, /^budget\./)
  assert.deepEqual(question?.options, ['Raise the budget (write the new USD number)', 'Stop the run'])
  assert.equal(question?.recommendation, 'Stop the run')
  assert.match(question?.question ?? '', /\$10\.00 of its budget of \$10\.00/)

  replies[posted[0]!.batch] = '/answer\nQ1: 12'
  await gate().check()
  assert.equal(gate().limit(), 12)
  await gate().check()
  assert.equal(posted.length, 1)
  assert.deepEqual(decisions(ledger), [])
})

test('an answer that is not a number above the spend asks again in a new batch', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  resolveBudget(ledger, 10)
  await assert.rejects(gate().check(), PausedError)
  replies[posted[0]!.batch] = '/answer\nQ1: 5'
  await assert.rejects(gate().check(), PausedError)
  replies[posted[1]!.batch] = '/answer\nQ1: a'
  await assert.rejects(gate().check(), PausedError)
  replies[posted[2]!.batch] = '/answer\nQ1: more please'
  await assert.rejects(gate().check(), PausedError)
  assert.equal(posted.length, 4)
  assert.equal(new Set(posted.map((post) => post.batch)).size, 4)
  replies[posted[3]!.batch] = '/answer\nQ1: $15.5'
  await gate().check()
  assert.equal(gate().limit(), 15.5)
  assert.deepEqual(decisions(ledger), [])
})

test('stop, the stop option and /answer recommended stop the run at the budget', async () => {
  for (const reply of ['/answer\nQ1: stop', '/answer\nQ1: b', '/answer recommended']) {
    const { ledger, posted, replies, gate } = spentTen()
    resolveBudget(ledger, 10)
    await assert.rejects(gate().check(), PausedError)
    replies[posted[0]!.batch] = reply
    await assert.rejects(gate().check(), BudgetStop)
    assert.deepEqual(decisions(ledger), [])
  }
})

test('a hotfix run takes the recommendation without a question', async () => {
  const { ledger, posted, gate } = spentTen()
  resolveBudget(ledger, 10)
  await assert.rejects(gate({ recommend: true }).check(), BudgetStop)
  assert.equal(posted.length, 0)
  assert.deepEqual(decisions(ledger), [])
})

test('the gate adds the extra spend', async () => {
  const { ledger, posted, gate } = spentTen()
  resolveBudget(ledger, 14)
  await gate().check()
  assert.equal(gate({ extraSpend: () => 5 }).spent(), 15)
  await assert.rejects(gate({ extraSpend: () => 5 }).check(), PausedError)
  assert.equal(posted.length, 1)
})

test('a new given budget replaces the recorded one; the same value keeps a raise', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  assert.equal(resolveBudget(ledger, undefined), undefined)
  assert.equal(resolveBudget(ledger, 10), 10)
  await assert.rejects(gate().check(), PausedError)
  replies[posted[0]!.batch] = '/answer\nQ1: 12'
  await gate().check()
  assert.equal(resolveBudget(ledger, 10), 12)
  assert.equal(resolveBudget(ledger, undefined), 12)
  assert.equal(resolveBudget(ledger, 30), 30)
  assert.equal(resolveBudget(fileLedgerCopy(ledger), undefined), 30)

  // A new budget above the spend lets a paused run go on without an answer.
  const paused = spentTen()
  resolveBudget(paused.ledger, 10)
  await assert.rejects(paused.gate().check(), PausedError)
  resolveBudget(paused.ledger, 11)
  await paused.gate().check()
  assert.equal(paused.posted.length, 1)
})

/** The same state in a new ledger object, as a resumed run reads it. */
function fileLedgerCopy(ledger: Ledger): Ledger {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-usage-')), 'state.json')
  const copy = fileLedger(path)
  copy.put('budget', ledger.get('budget'))
  return fileLedger(path)
}
