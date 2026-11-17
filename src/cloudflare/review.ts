import type { Ledger } from '../core/ledger.ts'
import { PausedError } from '../core/questions.ts'
import { addTokens, zeroTokens, type RunUsage } from '../core/usage.ts'
import type { LoopResult } from '../core/workflows/code-review-loop.ts'
import type { ReviewRequest } from '../core/workflows/develop.ts'
import type { Env, RunRequest } from './runs.ts'

/**
 * The review loop runs as a review run of the new PR, in that PR's own object, as a /review would. A finished review
 * run cannot resume. Thus, when a pass stopped at its budget and the parent run calls again after a raise, a new review
 * run starts with what remains after the earlier runs. The usage of the pass includes the earlier runs.
 */
export async function reviewPass(env: Env, request: RunRequest, ledger: Ledger, review: ReviewRequest): Promise<LoopResult> {
  const { owner, repo } = request
  const runs = env.PULL_REQUESTS.get(env.PULL_REQUESTS.idFromName(`${owner}/${repo}#${review.pr}`.toLowerCase()))
  const key = `review-run:${review.runId}`
  const stoppedKey = `review-stopped:${review.runId}`
  const stopped = ledger.get<Record<string, RunUsage>>(stoppedKey) ?? {}
  const earlierUsd = Object.values(stopped).reduce((sum, usage) => sum + usage.usd, 0)
  let run = ledger.get<string>(key)
  let outcome = run ? await runs.outcome(run) : undefined
  // The parent must collect the stopped usage and raise the budget before another run can start.
  if (run && stopped[run] && outcome?.waiting === undefined && outcome?.stopped && review.budget !== undefined && review.budget > earlierUsd) run = undefined
  if (!run || !outcome) {
    const budget = review.budget !== undefined ? { budget: review.budget - earlierUsd } : {}
    run = (await runs.start({ ask: review.ask, by: request.by, full: review.full, owner, pr: review.pr, repo, ship: false, stopAtBudget: true, ...budget })).run
    ledger.put(key, run)
    outcome = await runs.outcome(run)
  }
  if (outcome.waiting !== undefined) throw new PausedError(outcome.waiting)
  if (outcome.stopped && !stopped[run]) ledger.put(stoppedKey, { ...stopped, [run]: outcome.usage })
  // The current outcome can also be in the ledger after an earlier collection. Count each run once.
  const usage = [...Object.entries(stopped).filter(([id]) => id !== run).map(([, usage]) => usage), outcome.usage].reduce<RunUsage>(
    (a, b) => ({ tokens: addTokens(a.tokens, b.tokens), usd: a.usd + b.usd, unpriced: [...new Set([...a.unpriced, ...b.unpriced])] }),
    { tokens: zeroTokens(), usd: 0, unpriced: [] },
  )
  return { ...outcome, usage }
}
