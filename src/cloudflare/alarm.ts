import type { Ledger } from '../core/ledger.ts'
import { crashRestartsKey, PlannedStop, plannedStopsKey } from '../core/planned-stop.ts'
import { PausedError } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { refusedCredential } from './github.ts'

const maxAttempts = 3
/** Restarts of a run whose isolate died with no finished step in between, before the run stops. */
export const maxRestarts = 5
const retryMs = 60_000
const defaultPauseSeconds = 60
/**
 * The wall time that one alarm call plans for, when ALARM_BUDGET_SECONDS does not say (D12). Cloudflare stops the call
 * at 900 s. The rest is for the model request and the submit that are in flight at the end of the budget.
 */
export const defaultBudgetSeconds = 780

/** ALARM_BUDGET_SECONDS in ms. A value that is not a number above 0 gives the default. */
export function alarmBudgetMs(value: string | undefined): number {
  const seconds = Number(value)
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : defaultBudgetSeconds) * 1_000
}

/** A finished step is progress: it clears the counts of failed attempts and restarts, but not the report counters. */
export function progressLedger(ledger: Ledger): Ledger {
  return {
    get: (key) => ledger.get(key),
    put(key, value) {
      ledger.put(key, value)
      if (key.startsWith('step:')) {
        ledger.put('attempts', 0)
        ledger.put('restarts', 0)
      }
    },
  }
}

/** Sets the report counters to 0 when they are absent, so that each Cloudflare report shows them. */
export function initCounters(ledger: Ledger): void {
  for (const key of [plannedStopsKey, crashRestartsKey]) if (ledger.get(key) === undefined) ledger.put(key, 0)
}

/** Counts a call that finds the run `running`: the last call died mid-run. A crash that repeats stops instead of looping. */
export function countRestart(ledger: Ledger): void {
  const restarts = (ledger.get<number>('restarts') ?? 0) + 1
  ledger.put('restarts', restarts)
  ledger.put(crashRestartsKey, (ledger.get<number>(crashRestartsKey) ?? 0) + 1)
  if (restarts > maxRestarts) throw new StopError(`the run died ${maxRestarts} times without finishing a step, for example on the memory or CPU limit`)
}

/**
 * What the alarm call does after execute() threw: the state and note of the run, and the time of the next alarm
 * (null: no alarm). `attempts` is the count of failed attempts when the error counted as one, else null.
 */
export type Outcome = { state: 'queued' | 'paused' | 'error'; note: string; next: number | null; attempts: number | null }

export function afterError(ledger: Ledger, error: unknown, options: { now: number; pauseSeconds: string | undefined }): Outcome {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof PlannedStop) {
    // A planned stop is not a failure: attempts and restarts stay, and the next call starts at once.
    ledger.put(plannedStopsKey, (ledger.get<number>(plannedStopsKey) ?? 0) + 1)
    return { state: 'queued', note: `${message}. The run continues in the next alarm call.`, next: options.now, attempts: null }
  }
  if (error instanceof PausedError) {
    ledger.put('attempts', 0)
    return { state: 'paused', note: message, next: options.now + Number(options.pauseSeconds ?? defaultPauseSeconds) * 1_000, attempts: null }
  }
  const attempts = (ledger.get<number>('attempts') ?? 0) + 1
  ledger.put('attempts', attempts)
  // A refused credential or permission does not fix itself: stop at once instead of retrying.
  const permanent = error instanceof StopError || refusedCredential(error)
  if (permanent || attempts >= maxAttempts) return { state: 'error', note: message, next: null, attempts }
  return { state: 'queued', note: `attempt ${attempts} failed: ${message}`, next: options.now + retryMs, attempts }
}
