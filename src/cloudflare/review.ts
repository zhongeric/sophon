import type { Ledger } from '../core/ledger.ts'
import { PausedError } from '../core/questions.ts'
import type { LoopResult } from '../core/workflows/code-review-loop.ts'
import type { ReviewRequest } from '../core/workflows/develop.ts'

/** A finished review, or the cause of its pause. */
export type ReviewOutcome = { waiting: string } | (LoopResult & { waiting?: undefined })

type ReviewRuns = {
  start(request: { owner: string; repo: string; by: string; ask: string; full: boolean; pr: number; ship: boolean }): Promise<{ run: string; started: boolean }>
  ask(run: string): string | undefined | Promise<string | undefined>
  outcome(run: string): ReviewOutcome | Promise<ReviewOutcome>
}

/** Starts or resumes the review of the frozen package. */
export async function developmentReview(
  runs: ReviewRuns,
  ledger: Ledger,
  review: ReviewRequest,
  request: { owner: string; repo: string; by: string },
): Promise<LoopResult> {
  const key = `review-run:${review.runId}`
  let run = ledger.get<string>(key)
  if (!run) {
    const start = await runs.start({ ...request, ask: review.ask, full: review.full, pr: review.pr, ship: false })
    // A restart can find the review run before the ledger records it. Use that run only for the same frozen package.
    if (!start.started && (await runs.ask(start.run)) !== review.ask) throw new PausedError(`waiting for review run ${start.run} on the PR`)
    run = start.run
    ledger.put(key, run)
  }
  const outcome = await runs.outcome(run)
  if (outcome.waiting !== undefined) throw new PausedError(outcome.waiting)
  return outcome
}
