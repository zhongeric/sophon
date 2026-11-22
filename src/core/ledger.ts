/** Run state. Each platform stores it durably, and each write is complete before the next step starts. */
export type Ledger = {
  get<T>(key: string): T | undefined
  put(key: string, value: unknown): void
  /**
   * A point between steps and agent turns where the journal holds all finished work. The host can stop the run here (it
   * throws) and continue it in a new call. `nextMs` is the most wall time that the next work takes (D12).
   */
  safePoint?(nextMs?: number): void
  /** The wall time that the current host call has left, or undefined on a platform whose calls have no time limit (D12). */
  timeLeft?(): number
}

/** Runs `run` once per ledger. A resumed run returns the recorded result instead of running the step again. */
export async function step<T>(ledger: Ledger, name: string, run: () => Promise<T>): Promise<T> {
  const key = `step:${name}`
  const done = ledger.get<{ result: T }>(key)
  if (done) return done.result
  ledger.safePoint?.()
  const result = await run()
  ledger.put(key, { result })
  return result
}
