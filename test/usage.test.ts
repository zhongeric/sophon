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
  clearBudget,
  costOf,
  parseBudget,
  parsePrices,
  recordUsage,
  resolveBudget,
  spendOf,
  usageOf,
  usageSection,
  zeroTokens,
  type Prices,
  type UsageRow,
} from '../src/core/usage.ts'
import { fileLedger } from '../src/node/ledger.ts'

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, structuredClone(value)) }
}

/**
 * A channel that answers each batch from `replies`. A batch without a reply has no answer yet. `events` keeps the order
 * of the notices and the posts. Without `notice`, the channel has no notice method.
 */
function scriptedChannel(replies: Record<string, string> = {}, notice = true) {
  const posted: { batch: string; questions: Question[] }[] = []
  const notices: string[] = []
  const events: string[] = []
  const channel: Channel = {
    async post(_runId, batch, questions) {
      posted.push({ batch, questions })
      events.push(`post ${batch}`)
      return { batch, ref: `memory:${batch}`, at: new Date().toISOString() }
    },
    async answers(where, questions) {
      const reply = replies[where.batch]
      return reply === undefined ? null : parseAnswers(reply, questions)
    },
    where: (where) => where.ref,
    ...(notice
      ? {
          async notice(_runId: string, text: string) {
            notices.push(text)
            events.push('notice')
          },
        }
      : {}),
  }
  return { channel, posted, replies, notices, events }
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
      { step: 'a', model: 'm1', tokens: { input: 105, cached: 40, cache_write: 10, output: 20 } },
      { step: 'b', model: 'm2', tokens: { input: 7, cached: 0, cache_write: 0, output: 3 } },
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
  assert.deepEqual(usageOf(ledger).total, { input: 1010, cached: 0, cache_write: 0, output: 101 })

  const rows = [
    ...usageOf(ledger).agents,
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
function spentTen(options: { notice?: boolean } = {}) {
  const ledger = memoryLedger()
  recordUsage(ledger, 'a', 'm1', [call('r1', 1, { input_tokens: 10 })])
  const prices: Prices = { m1: { input: 1e6, cached_input: 0, cache_write: 0, output: 0 } }
  const { channel, posted, replies, notices, events } = scriptedChannel({}, options.notice ?? true)
  const logs: string[] = []
  const gate = (more: { extraRows?: () => UsageRow[]; recommend?: boolean; stopAtLimit?: boolean } = {}, on: Ledger = ledger) =>
    budgetGate({ ledger: on, channel, runId: 'run-1', prices, log: (line) => void logs.push(line), ...more })
  return { ledger, posted, replies, notices, events, logs, gate }
}

const row = (step: string, usd: number | undefined): UsageRow => ({ step, model: 'review loop', tokens: zeroTokens(), ...(usd === undefined ? {} : { usd }) })

test('without a budget or under it, the gate asks nothing', async () => {
  const { ledger, posted, notices, gate } = spentTen()
  await gate().check()
  assert.equal(gate().limit(), undefined)
  assert.equal(resolveBudget(ledger, 20), 20)
  await gate().check()
  assert.equal(gate().spent(), 10)
  assert.equal(posted.length, 0)
  assert.equal(notices.length, 0)
})

test('clearBudget removes the limit without removing usage or reusing budget answers', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  clearBudget(ledger)
  assert.equal(resolveBudget(ledger, 5), 5)
  await assert.rejects(gate().check(), PausedError)
  const first = posted[0]
  assert.ok(first)
  replies[first.batch] = '/answer\nQ1: 12'

  clearBudget(ledger)
  clearBudget(ledger)
  assert.equal(resolveBudget(ledger, undefined), undefined)
  assert.equal(gate().limit(), undefined)
  assert.equal(gate().spent(), 10)
  await gate().check()
  assert.equal(posted.length, 1)

  assert.equal(resolveBudget(ledger, 5), 5)
  await assert.rejects(gate().check(), PausedError)
  assert.equal(posted.length, 2)
  assert.notEqual(posted[1]?.batch, first.batch)
})

test('at the budget, concurrent checks post one notice for the round, and the run continues without a question', async () => {
  const { ledger, posted, notices, logs, gate } = spentTen()
  resolveBudget(ledger, 10)
  const one = gate()
  const checks = [one.check(), one.check(), one.check()]
  assert.equal(checks[0], checks[1])
  await Promise.all(checks)
  await gate().check()
  assert.equal(posted.length, 0)
  assert.deepEqual(notices, [
    'The run spent about $10.00 of its budget of $10.00. The run continues. At $20.00, twice the budget, the host pauses and asks you to raise the budget or to stop the run. The most expensive steps: a $10.00.',
  ])
  assert.deepEqual(logs, [`budget notice: ${notices[0]}`])

  // A resumed run reads the notice of the round from the ledger, and does not post it again.
  const round = ledger.get<{ round: number }>('budget')?.round
  await gate({}, fileLedgerCopy(ledger, ['budget', 'usage', `budget-notice.${round}`])).check()
  assert.equal(notices.length, 1)

  // A new budget is a new round, with its own notice.
  resolveBudget(ledger, 9)
  await gate().check()
  assert.equal(notices.length, 2)
  assert.match(notices[1] ?? '', /of its budget of \$9\.00\./)
  assert.equal(posted.length, 0)
  assert.deepEqual(decisions(ledger), [])
})

test('at twice the budget, concurrent checks post the notice, then one question, and pause; a higher number raises the budget', async () => {
  const { ledger, posted, replies, notices, events, logs, gate } = spentTen()
  resolveBudget(ledger, 5)
  const one = gate()
  const checks = [one.check(), one.check(), one.check()]
  assert.equal(checks[0], checks[1])
  const results = await Promise.allSettled(checks)
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason instanceof PausedError))
  assert.deepEqual(events, ['notice', 'post budget.1'])
  assert.equal(notices.length, 1)
  const [question] = posted[0]!.questions
  assert.deepEqual(question?.options, ['Raise the budget to $20.00', 'Raise the budget (write the new USD number)', 'Stop the run'])
  assert.equal(question?.recommendation, 'Raise the budget to $20.00')
  assert.deepEqual([question?.level, question?.rule], ['user', 'spend'])
  assert.match(question?.question ?? '', /\$10\.00 of its budget of \$5\.00\. Raise the budget or stop the run\?/)

  // A resume asks nothing new while the question waits.
  await assert.rejects(gate().check(), PausedError)
  assert.deepEqual(events, ['notice', 'post budget.1'])

  replies[posted[0]!.batch] = '/answer\nQ1: 12'
  await gate().check()
  assert.equal(gate().limit(), 12)
  assert.ok(logs.includes('budget raised to $12.00'))
  await gate().check()
  assert.equal(posted.length, 1)
  assert.equal(notices.length, 1)
  assert.deepEqual(decisions(ledger), [])
})

test('/answer recommended and its option letter raise the budget to twice the spend, rounded up to the cent', async () => {
  for (const reply of ['/answer recommended', '/answer\nQ1: a']) {
    const { ledger, posted, replies, gate } = spentTen()
    const extraRows = () => [row('review.1', 0.123)]
    resolveBudget(ledger, 5)
    await assert.rejects(gate({ extraRows }).check(), PausedError)
    assert.equal(posted[0]?.questions[0]?.recommendation, 'Raise the budget to $20.25')
    replies[posted[0]!.batch] = reply
    // A new gate reads the value from the recorded option, as a resumed run does.
    await gate({ extraRows }).check()
    assert.equal(gate().limit(), 20.25)
    assert.equal(posted.length, 1)
    assert.deepEqual(decisions(ledger), [])
  }
})

test('an answer that is not a number above the spend asks again in a new batch, without a new notice', async () => {
  const { ledger, posted, replies, notices, gate } = spentTen()
  resolveBudget(ledger, 5)
  await assert.rejects(gate().check(), PausedError)
  replies[posted[0]!.batch] = '/answer\nQ1: 5'
  await assert.rejects(gate().check(), PausedError)
  replies[posted[1]!.batch] = '/answer\nQ1: 10'
  await assert.rejects(gate().check(), PausedError)
  replies[posted[2]!.batch] = '/answer\nQ1: b'
  await assert.rejects(gate().check(), PausedError)
  replies[posted[3]!.batch] = '/answer\nQ1: more please'
  await assert.rejects(gate().check(), PausedError)
  assert.equal(posted.length, 5)
  assert.equal(new Set(posted.map((post) => post.batch)).size, 5)
  assert.equal(notices.length, 1)
  replies[posted[4]!.batch] = '/answer\nQ1: $15.5'
  await gate().check()
  assert.equal(gate().limit(), 15.5)
  assert.deepEqual(decisions(ledger), [])
})

test('round-off at the budget posts the notice, and round-off at twice the budget asks and requires a higher budget', async () => {
  const ledger = memoryLedger()
  const prices = { m1: { input: 100_000, cached_input: 0, cache_write: 0, output: 0 } }
  recordUsage(ledger, 'a', 'm1', [call('r1', 1, { input_tokens: 2 })])
  const { channel, posted, replies, notices } = scriptedChannel()
  const gate = budgetGate({ ledger, prices, channel, runId: 'round-off', extraRows: () => [row('review.1', 0.7)], log: () => {} })
  assert.equal(gate.spent(), 0.2 + 0.7)
  resolveBudget(ledger, 0.900001)
  await gate.check()
  assert.equal(notices.length, 0)

  resolveBudget(ledger, 0.9)
  await gate.check()
  assert.equal(notices.length, 1)

  resolveBudget(ledger, 0.4500001)
  await gate.check()
  assert.equal(notices.length, 2)
  assert.equal(posted.length, 0)

  resolveBudget(ledger, 0.45)
  await assert.rejects(gate.check(), PausedError)
  assert.equal(posted.length, 1)
  const first = posted[0]
  assert.ok(first)
  assert.equal(first.questions[0]?.recommendation, 'Raise the budget to $1.80')
  replies[first.batch] = '/answer\nQ1: 0.9'
  await assert.rejects(gate.check(), PausedError)
  assert.equal(posted.length, 2)
  const second = posted[1]
  assert.ok(second)
  replies[second.batch] = '/answer\nQ1: 1.2'
  await gate.check()
  await gate.check()
  assert.equal(gate.limit(), 1.2)
  assert.equal(posted.length, 2)
})

test('stop, the letter of the stop option and the stop option stop the run at twice the budget', async () => {
  for (const reply of ['/answer\nQ1: stop', '/answer\nQ1: c', '/answer\nQ1: Stop the run']) {
    const { ledger, posted, replies, gate } = spentTen()
    resolveBudget(ledger, 5)
    await assert.rejects(gate().check(), PausedError)
    replies[posted[0]!.batch] = reply
    await assert.rejects(gate().check(), (error) => error instanceof BudgetStop && error.message === 'stopped at the cost budget: spent $10.00 of $5.00')
    assert.deepEqual(decisions(ledger), [])
  }
})

test('a hotfix run raises the budget to twice the spend at twice the budget, with a notice and without a question', async () => {
  const { ledger, posted, notices, logs, gate } = spentTen()
  resolveBudget(ledger, 5)
  await gate({ recommend: true }).check()
  assert.equal(gate().limit(), 20)
  assert.equal(posted.length, 0)
  assert.deepEqual(notices, [
    'The run spent about $10.00 of its budget of $5.00. This is a hotfix run, so the host raised the budget to $20.00, and the run continues. The most expensive steps: a $10.00.',
  ])
  assert.ok(logs.includes('budget raised to $20.00'))
  assert.ok(logs.includes(`budget notice: ${notices[0]}`))
  await gate({ recommend: true }).check()
  assert.equal(notices.length, 1)
  assert.deepEqual(decisions(ledger), [])
})

test('a channel without notice continues at the budget, and the notice goes only to the log', async () => {
  const { ledger, posted, logs, gate } = spentTen({ notice: false })
  resolveBudget(ledger, 10)
  await gate().check()
  assert.equal(posted.length, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /^budget notice: The run spent about \$10\.00 of its budget of \$10\.00\./)
})

test('the stop-at-limit option stops at the budget without a notice or a question', async () => {
  const { ledger, posted, notices, gate } = spentTen()
  resolveBudget(ledger, 20)
  await gate({ stopAtLimit: true }).check()
  resolveBudget(ledger, 10)
  await assert.rejects(gate({ stopAtLimit: true }).check(), (error) => error instanceof BudgetStop && error.message === 'stopped at the cost budget: spent $10.00 of $10.00')
  assert.equal(posted.length, 0)
  assert.equal(notices.length, 0)
})

test('the gate adds the extra rows to the spend, and the notice lists the three most expensive priced steps', async () => {
  const { ledger, posted, notices, gate } = spentTen()
  recordUsage(ledger, 'b', 'm2', [call('r2', 1, { input_tokens: 1000 })])
  const extraRows = () => [row('review.1', 5), row('review.2', undefined), row('review.3', 0.5), row('review.4', 1)]
  resolveBudget(ledger, 17)
  await gate().check()
  assert.equal(gate({ extraRows }).spent(), 16.5)
  await gate({ extraRows }).check()
  assert.equal(notices.length, 0)
  resolveBudget(ledger, 16)
  await gate({ extraRows }).check()
  assert.equal(posted.length, 0)
  assert.equal(notices.length, 1)
  assert.match(notices[0] ?? '', /^The run spent about \$16\.50 of its budget of \$16\.00\..* The most expensive steps: a \$10\.00, review\.1 \$5\.00, review\.4 \$1\.00\.$/)
})

test('a new given budget replaces the recorded one; the same value keeps a raise', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  assert.equal(resolveBudget(ledger, undefined), undefined)
  assert.equal(resolveBudget(ledger, 5), 5)
  await assert.rejects(gate().check(), PausedError)
  replies[posted[0]!.batch] = '/answer\nQ1: 12'
  await gate().check()
  assert.equal(resolveBudget(ledger, 5), 12)
  assert.equal(resolveBudget(ledger, undefined), 12)
  assert.equal(resolveBudget(ledger, 30), 30)
  assert.equal(resolveBudget(fileLedgerCopy(ledger), undefined), 30)

  // A new budget above the spend lets a paused run go on without an answer.
  const paused = spentTen()
  resolveBudget(paused.ledger, 5)
  await assert.rejects(paused.gate().check(), PausedError)
  resolveBudget(paused.ledger, 11)
  await paused.gate().check()
  assert.equal(paused.posted.length, 1)
})

test('a budget of the current invocation applies also when it is the same as the first given value', async () => {
  const { ledger, posted, replies, gate } = spentTen()
  assert.equal(resolveBudget(ledger, 5), 5)
  await assert.rejects(gate().check(), PausedError)
  replies[posted[0]!.batch] = '/answer\nQ1: 12'
  await gate().check()
  assert.equal(resolveBudget(ledger, 5), 12)
  // A resume with --budget 5 lowers the budget again, and a later resume without --budget keeps it.
  assert.equal(resolveBudget(ledger, 5, 5), 5)
  assert.equal(resolveBudget(fileLedgerCopy(ledger), 5), 5)
  await assert.rejects(gate().check(), PausedError)
  assert.equal(posted.length, 2)
})

/** The same state in a new ledger object, as a resumed run reads it. */
function fileLedgerCopy(ledger: Ledger, keys = ['budget']): Ledger {
  const path = join(mkdtempSync(join(tmpdir(), 'factory-usage-')), 'state.json')
  const copy = fileLedger(path)
  for (const key of keys) copy.put(key, ledger.get(key))
  return fileLedger(path)
}
