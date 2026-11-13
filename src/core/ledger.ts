/** Run state. Each platform stores it durably, and each write is complete before the next step starts. */
export type Ledger = {
  get<T>(key: string): T | undefined
  put(key: string, value: unknown): void
}

/** Runs `run` once per ledger. A resumed run returns the recorded result instead of running the step again. */
export async function step<T>(ledger: Ledger, name: string, run: () => Promise<T>): Promise<T> {
  const key = `step:${name}`
  const done = ledger.get<{ result: T }>(key)
  if (done) return done.result
  const result = await run()
  ledger.put(key, { result })
  return result
}
