import type { Ledger } from '../core/ledger.ts'
import { PausedError } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { addTokens, zeroTokens, type RunUsage } from '../core/usage.ts'
import type { LoopResult } from '../core/workflows/code-review-loop.ts'
import type { ReviewRequest } from '../core/workflows/develop.ts'

/**
 * A finished review as the development workflow needs it: the fixes as a commit on GitHub. `error` is the note of a
 * review run that waits with `error`, so that the parent run can restart it (D13).
 */
export type ReviewOutcome =
  | { error: string; waiting?: undefined }
  | { waiting: string; error?: undefined }
  | (LoopResult & { waiting?: undefined; error?: undefined })

/**
 * The methods of PullRequestRuns that a pass calls. The types are local, because this file must typecheck with Node
 * types for its tests, and run.ts needs the Worker types.
 */
export type ReviewRuns = {
  start(request: { ask: string; by: string; full: boolean; owner: string; pr: number; repo: string; ship: boolean; stopAtBudget: boolean; budget?: number }): Promise<{ run: string }>
  outcome(run: string): Promise<ReviewOutcome>
  resumeAfterError(run: string): Promise<{ reason: string; resumed: boolean }>
}

/**
 * The review loop runs as a review run of the new PR, in that PR's own object, as a /review would. A finished review
 * run cannot resume. Thus, when a pass stopped at its budget and the parent run calls again after a raise, a new review
 * run starts with what remains after the earlier runs. The usage of the pass includes the earlier runs.
 *
 * A review run in `error` is an error of the parent run (D13). The first call that sees it records it and stops the
 * parent, so that D13 counts the restart. The next call, a restart or the admin resume of the parent, resumes the review run.
 */
export async function reviewPass<Id>(
  env: { PULL_REQUESTS: { idFromName(name: string): Id; get(id: Id): ReviewRuns } },
  request: { owner: string; repo: string; by: string },
  ledger: Ledger,
  review: ReviewRequest,
): Promise<LoopResult> {
  const { owner, repo } = request
  const runs = env.PULL_REQUESTS.get(env.PULL_REQUESTS.idFromName(`${owner}/${repo}#${review.pr}`.toLowerCase()))
  const key = `review-run:${review.runId}`
  const stoppedKey = `review-stopped:${review.runId}`
  const errorKey = `review-error:${review.runId}`
  const stopped = ledger.get<Record<string, RunUsage>>(stoppedKey) ?? {}
  const earlierUsd = Object.values(stopped).reduce((sum, usage) => sum + usage.usd, 0)
  let run = ledger.get<string>(key)
  let outcome = run ? await runs.outcome(run) : undefined
  // The parent must collect the stopped usage and raise the budget before another run can start.
  if (run && stopped[run] && outcome?.error === undefined && outcome?.waiting === undefined && outcome?.stopped && review.budget !== undefined && review.budget > earlierUsd) run = undefined
  if (!run || !outcome) {
    const budget = review.budget !== undefined ? { budget: review.budget - earlierUsd } : {}
    run = (await runs.start({ ask: review.ask, by: request.by, full: review.full, owner, pr: review.pr, repo, ship: false, stopAtBudget: true, ...budget })).run
    ledger.put(key, run)
    outcome = await runs.outcome(run)
  }
  if (outcome.error !== undefined) {
    if (!ledger.get<boolean>(errorKey)) {
      ledger.put(errorKey, true)
      throw new StopError(`review run ${run} stopped: ${outcome.error}`, { transient: true })
    }
    const resume = await runs.resumeAfterError(run)
    // A refused resume keeps the record, so that the next poll tries the resume again without a D13 count.
    if (resume.resumed) ledger.put(errorKey, false)
    throw new PausedError(resume.reason)
  }
  // A record of an earlier error must not resume a later error without a D13 count.
  if (ledger.get<boolean>(errorKey)) ledger.put(errorKey, false)
  if (outcome.waiting !== undefined) throw new PausedError(outcome.waiting)
  if (outcome.stopped && !stopped[run]) ledger.put(stoppedKey, { ...stopped, [run]: outcome.usage })
  // The current outcome can also be in the ledger after an earlier collection. Count each run once.
  const usage = [...Object.entries(stopped).filter(([id]) => id !== run).map(([, usage]) => usage), outcome.usage].reduce<RunUsage>(
    (a, b) => ({ tokens: addTokens(a.tokens, b.tokens), usd: a.usd + b.usd, unpriced: [...new Set([...a.unpriced, ...b.unpriced])] }),
    { tokens: zeroTokens(), usd: 0, unpriced: [] },
  )
  return { ...outcome, usage }
}
