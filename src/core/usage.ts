import type { Contracts } from 'nanocode-ts'
import type { Ledger } from './ledger.ts'
import { asker, type Channel, type Question } from './questions.ts'
import { StopError } from './stop.ts'

/** Token counts. `input` includes the cached and the cache-write tokens, as the providers report it. */
export type Tokens = { input: number; cached: number; cache_write: number; output: number }

/** USD per million tokens of one model. */
export type ModelPrice = { input: number; cached_input: number; cache_write: number; output: number }
export type Prices = Record<string, ModelPrice>

/** The usage summary of one finished run. `unpriced` gives the models that have tokens but no price. */
export type RunUsage = { tokens: Tokens; usd: number; unpriced: string[] }

/** One row of the Usage section. A row with `usd` is precomputed, for example a review pass of a development run. */
export type UsageRow = { step: string; model: string; tokens: Tokens; usd?: number; unpriced?: string[] }

/** The usage of one agent in the ledger. `seen` keeps the highest counted event sequence of each SDK run. */
type AgentUsage = { model: string; tokens: Tokens; seen: Record<string, number> }
type UsageRecord = { agents: Record<string, AgentUsage>; total: Tokens }

type BudgetState = { limit?: number; given?: number; round: number }

const usageKey = 'usage'
const budgetKey = 'budget'
const priceFields = ['input', 'cached_input', 'cache_write', 'output'] as const

export const zeroTokens = (): Tokens => ({ input: 0, cached: 0, cache_write: 0, output: 0 })

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, cached: a.cached + b.cached, cache_write: a.cache_write + b.cache_write, output: a.output + b.output }
}

/** Reads MODEL_PRICES. An invalid setting stops the run, also without a budget. */
export function parsePrices(setting: string | undefined): Prices {
  if (setting === undefined || setting.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(setting)
  } catch (error) {
    throw new StopError(`MODEL_PRICES is not valid JSON: ${(error as Error).message}`)
  }
  if (!isObject(parsed)) throw new StopError('MODEL_PRICES must be a JSON object of model IDs')
  const prices: Prices = {}
  for (const [model, entry] of Object.entries(parsed)) {
    if (!isObject(entry)) throw new StopError(`MODEL_PRICES: ${model} must be an object with ${priceFields.join(', ')}`)
    const price = (field: (typeof priceFields)[number]): number => {
      const value = entry[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new StopError(`MODEL_PRICES: ${model}.${field} must be a non-negative number of USD per million tokens`)
      return value
    }
    prices[model] = { input: price('input'), cached_input: price('cached_input'), cache_write: price('cache_write'), output: price('output') }
  }
  return prices
}

/** Reads a budget in USD from a CLI argument or a request body. */
export function parseBudget(value: unknown): number {
  const budget = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(budget) || budget <= 0) throw new StopError(`budget must be a positive number of USD, not ${JSON.stringify(value) ?? String(value)}`)
  return budget
}

/** A budget needs a price for every model of the run, as a missing key stops the run before any work. */
export function checkPriced(models: string[], prices: Prices): void {
  const missing = [...new Set(models)].filter((model) => !(model in prices))
  if (missing.length > 0) throw new StopError(`the run has a budget, but MODEL_PRICES has no price for: ${missing.join(', ')}`)
}

export function costOf(tokens: Tokens, price: ModelPrice): number {
  // Some providers report input without the cached tokens. Then the difference is negative, and the plain input costs nothing.
  const plain = Math.max(0, tokens.input - tokens.cached - tokens.cache_write)
  return (plain * price.input + tokens.cached * price.cached_input + tokens.cache_write * price.cache_write + tokens.output * price.output) / 1e6
}

/**
 * Adds the tokens of each completed model call to the sums of the agent and of the run. The ledger keeps the highest
 * counted sequence of each SDK run, so a republished event, a reconnect or a resumed run does not count a call again.
 * Events of subagents arrive here too, and count for the parent agent.
 */
export function recordUsage(ledger: Ledger, agentId: string, model: string, events: Contracts.LoggedEvent[]): void {
  const record = usageRecord(ledger)
  const agent: AgentUsage = { ...(record.agents[agentId] ?? { model, tokens: zeroTokens(), seen: {} }), model }
  let total = record.total
  let changed = false
  for (const logged of events) {
    const call = modelCall((logged.event as { event?: unknown } | null)?.event, logged)
    if (!call) continue
    const seen = agent.seen[call.run]
    if (seen !== undefined && call.seq <= seen) continue
    agent.seen = { ...agent.seen, [call.run]: call.seq }
    changed = true
    if (call.replayed) continue
    agent.tokens = addTokens(agent.tokens, call.tokens)
    total = addTokens(total, call.tokens)
  }
  if (!changed) return
  ledger.put(usageKey, { agents: { ...record.agents, [agentId]: agent }, total } satisfies UsageRecord)
}

/** One completed model call. `run` and `seq` identify it, so that a republished event counts one time. */
export type ModelCall = { run: string; seq: number; replayed: boolean; tokens: Tokens }

/** Reads a `model.call.completed` event of the SDK. `logged` gives the run and the sequence when the event has none. */
export function modelCall(event: unknown, logged: Contracts.LoggedEvent): ModelCall | undefined {
  const inner = event as InnerEvent | null | undefined
  if (inner?.type !== 'model.call.completed') return undefined
  const usage = inner.payload?.usage
  return {
    run: typeof inner.request_id === 'string' ? inner.request_id : (logged.request_id ?? ''),
    seq: typeof inner.seq === 'number' ? inner.seq : logged.seq,
    // A replayed call comes from the journal: the provider did not bill it again.
    replayed: inner.payload?.timing?.replayed === true,
    tokens: {
      input: count(usage?.input_tokens),
      cached: count(usage?.input_tokens_details?.cached_tokens),
      cache_write: count(usage?.input_tokens_details?.cache_write_tokens),
      output: count(usage?.output_tokens),
    },
  }
}

type InnerEvent = {
  type?: string
  request_id?: unknown
  seq?: unknown
  payload?: {
    usage?: { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null } | null
    timing?: { replayed?: unknown } | null
  }
}

/** The token sums of the run, and one row of the Usage section for each agent. */
export function usageOf(ledger: Ledger): { agents: UsageRow[]; total: Tokens } {
  const record = usageRecord(ledger)
  return { agents: Object.entries(record.agents).map(([step, agent]) => ({ step, model: agent.model, tokens: agent.tokens })), total: record.total }
}

/** The estimated USD of the priced agents, and the models without a price. */
export function spendOf(ledger: Ledger, prices: Prices): { usd: number; unpriced: string[] } {
  let usd = 0
  const unpriced = new Set<string>()
  for (const agent of usageOf(ledger).agents) {
    const price = prices[agent.model]
    if (price) usd += costOf(agent.tokens, price)
    else unpriced.add(agent.model)
  }
  return { usd, unpriced: [...unpriced] }
}

const formatUsd = (usd: number) => `$${usd.toFixed(usd < 1 ? 4 : 2)}`

/** The Markdown lines of the Usage section of a report. */
export function usageSection(rows: UsageRow[], prices: Prices, budget?: { limit: number; spent: number }): string[] {
  let total = zeroTokens()
  let usd = 0
  const unpriced = new Set<string>()
  const lines = rows.map((row) => {
    const price = prices[row.model]
    const cost = row.usd ?? (price ? costOf(row.tokens, price) : undefined)
    const missing = row.usd === undefined ? (price ? [] : [row.model]) : (row.unpriced ?? [])
    total = addTokens(total, row.tokens)
    usd += cost ?? 0
    for (const model of missing) unpriced.add(model)
    const shown = cost === undefined ? 'no price' : missing.length > 0 ? `${formatUsd(cost)} (no price: ${missing.join(', ')})` : formatUsd(cost)
    return tableRow(row.step, row.model, row.tokens, shown)
  })
  return [
    '## Usage',
    '',
    'The USD values are estimates from the prices in MODEL_PRICES. The input count includes the cached and the cache-write tokens.',
    '',
    '| Step | Model | Input | Cached | Cache write | Output | USD |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...lines,
    tableRow('**Total**', '', total, `${formatUsd(usd)}${unpriced.size > 0 ? ` (${unpriced.size} ${unpriced.size === 1 ? 'model' : 'models'} without a price)` : ''}`),
    ...(budget ? ['', `Budget: ${formatUsd(budget.limit)}. Spent: ${formatUsd(budget.spent)}.`] : []),
  ]
}

const tableRow = (step: string, model: string, tokens: Tokens, usd: string) =>
  `| ${step} | ${model} | ${tokens.input} | ${tokens.cached} | ${tokens.cache_write} | ${tokens.output} | ${usd} |`

/**
 * The budget of the run, kept in the ledger. `override` comes from the current invocation, for example --budget on a
 * resume, and always replaces the budget. `recorded` comes from the recorded input. It replaces the budget only when
 * it is not the last recorded value, so that a resume without a new value keeps the recorded budget or the last raise.
 */
export function resolveBudget(ledger: Ledger, recorded: number | undefined, override?: number): number | undefined {
  const state = budgetState(ledger)
  const value = override ?? (recorded === state.given ? undefined : recorded)
  if (value === undefined) return state.limit
  if (value === state.limit && recorded === state.given) return value
  // A new round, so that a later question does not read the answers of a question about the old budget.
  ledger.put(budgetKey, { limit: value, given: recorded, round: state.round + 1 } satisfies BudgetState)
  return value
}

/** A new budget round makes sure that later questions do not read answers for the removed limit. */
export function clearBudget(ledger: Ledger): void {
  const state = budgetState(ledger)
  if (state.limit !== undefined) ledger.put(budgetKey, { round: state.round + 1 } satisfies BudgetState)
}

/** The user chose to stop the run at the cost budget. */
export class BudgetStop extends Error {
  override name = 'BudgetStop'
}

/** Treat round-off near the limit as an exhausted budget. */
export function belowBudget(spent: number, limit: number): boolean {
  const tolerance = 8 * Number.EPSILON * Math.max(Math.abs(spent), Math.abs(limit))
  return limit - spent > tolerance
}

const raiseOption = 'Raise the budget (write the new USD number)'
const stopOption = 'Stop the run'

/**
 * Compares the spend with the budget before each agent turn. At the budget or over it, the run asks the user to raise
 * the budget or to stop. Concurrent checks share one question. The answers do not go into the decisions of the run,
 * because the agents read those.
 */
export function budgetGate(options: {
  ledger: Ledger
  channel: Channel
  runId: string
  prices: Prices
  log(line: string): void
  /** USD that the ledger does not record, for example finished review passes. */
  extraSpend?: () => number
  /** Stop at the budget without a question, as in a hotfix run, because the recommendation is to stop. */
  recommend?: boolean
}) {
  const { ledger, prices } = options
  const ask = asker(ledger, options.channel, options.runId, options.log, { decisions: false })
  const spent = () => spendOf(ledger, prices).usd + (options.extraSpend?.() ?? 0)
  const limit = () => budgetState(ledger).limit
  let pending: Promise<void> | undefined

  const settle = async (): Promise<void> => {
    for (;;) {
      const state = budgetState(ledger)
      const now = spent()
      if (state.limit === undefined || belowBudget(now, state.limit)) return
      const stop = new BudgetStop(`stopped at the cost budget: spent ${formatUsd(now)} of ${formatUsd(state.limit)}`)
      // A hotfix run takes the recommendation, and the recommendation is to stop.
      if (options.recommend) throw stop
      const batch = `budget.${state.round}`
      const questions: Question[] = [
        {
          id: 'Q1',
          question: `The run spent about ${formatUsd(now)} of its budget of ${formatUsd(state.limit)}. Raise the budget or stop the run?`,
          why: 'The host opens no more agent turns until the spend is below the budget. To raise the budget, write a new USD number above the spend.',
          options: [raiseOption, stopOption],
          recommendation: stopOption,
          // Spend over the budget is the user's decision (D11).
          level: 'user',
          rule: 'spend',
        },
      ]
      await ask.post(batch, questions)
      const text = ((await ask.wait(batch))[0]?.answer ?? stopOption).trim()
      if (text === stopOption || /^stop\b/i.test(text)) throw stop
      const raised = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(text)
      const value = raised ? Number(raised[1]) : Number.NaN
      if (belowBudget(now, value)) {
        ledger.put(budgetKey, { ...state, limit: value, round: state.round + 1 } satisfies BudgetState)
        options.log(`budget raised to ${formatUsd(value)}`)
        return
      }
      options.log(`budget answer ${JSON.stringify(text)} is not a number above the spend, asking again`)
      ledger.put(budgetKey, { ...state, round: state.round + 1 } satisfies BudgetState)
    }
  }

  return {
    check(): Promise<void> {
      const current = limit()
      if (current === undefined || belowBudget(spent(), current)) return Promise.resolve()
      pending ??= settle().finally(() => {
        pending = undefined
      })
      return pending
    },
    limit,
    spent,
  }
}

function usageRecord(ledger: Ledger): UsageRecord {
  return ledger.get<UsageRecord>(usageKey) ?? { agents: {}, total: zeroTokens() }
}

function budgetState(ledger: Ledger): BudgetState {
  return ledger.get<BudgetState>(budgetKey) ?? { round: 0 }
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
