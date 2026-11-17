import type { Ledger } from './ledger.ts'

/** The host stopped the run at a safe point, because the call used its time budget. A new call continues the run. */
export class PlannedStop extends Error {
  override name = 'PlannedStop'
}

/** The ledger keys of new work: a finished step (`step()`), a submitted output and a finished agent turn (`runTurn`, `ask`). */
export const progressPrefixes = ['step:', 'output:', 'report:'] as const

/**
 * The ledger of one host call with a time budget. Its safe point stops the run with a PlannedStop when the budget is
 * spent, but only after the call recorded new work. Thus each call moves the run forward, also with a very small budget.
 * A put of a key that the ledger already holds, for example the report of a replayed journal turn, is not new work.
 */
export function callBudget(ledger: Ledger, budget: { budgetMs: number; startedAt: number; now?: () => number }): Ledger {
  const now = budget.now ?? Date.now
  let progress = false
  return {
    get: <T>(key: string) => ledger.get<T>(key),
    put(key, value) {
      const fresh = progressPrefixes.some((prefix) => key.startsWith(prefix)) && ledger.get(key) === undefined
      ledger.put(key, value)
      if (fresh) progress = true
    },
    safePoint() {
      const used = now() - budget.startedAt
      if (progress && used >= budget.budgetMs) throw new PlannedStop(`the call used ${Math.round(used / 1000)} s of its budget of ${Math.round(budget.budgetMs / 1000)} s`)
    },
  }
}

/**
 * The failure to keep when `error` comes after `failure`: a real error replaces a PlannedStop, else the first failure stays.
 * An object, so that a thrown undefined still counts as a failure.
 */
export function keepFailure(failure: { error: unknown } | undefined, error: unknown): { error: unknown } {
  return !failure || (failure.error instanceof PlannedStop && !(error instanceof PlannedStop)) ? { error } : failure
}

/**
 * Waits until each promise settles, so that no agent works after the call ends. Then gives the results in order, or
 * throws the failure that `keepFailure` keeps: a real error before a PlannedStop, and the first real error before later ones.
 */
export async function settleAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = new Array<T>(promises.length)
  let failure: { error: unknown } | undefined
  await Promise.all(
    promises.map(async (promise, index) => {
      try {
        results[index] = await promise
      } catch (error) {
        failure = keepFailure(failure, error)
      }
    }),
  )
  if (failure) throw failure.error
  return results
}

/** Ledger counters of the alarm calls of a Cloudflare run. They never go back to 0. */
export const plannedStopsKey = 'planned-stops'
export const crashRestartsKey = 'crash-restarts'

/** The report line of the alarm counters, or no line when the ledger has no counter, as on the local platform. */
export function alarmLines(ledger: Ledger): string[] {
  const stops = ledger.get<number>(plannedStopsKey)
  const restarts = ledger.get<number>(crashRestartsKey)
  if (stops === undefined && restarts === undefined) return []
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  return [`- Alarm calls: ${count(stops ?? 0, 'planned stop')}, ${count(restarts ?? 0, 'crash restart')}`]
}
