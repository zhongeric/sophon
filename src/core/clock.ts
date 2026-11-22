/**
 * The time and the random IDs of a run. A test gives a fake clock to make a run deterministic, so that it does not
 * replace Date.now, the timers or crypto for the whole process. Each function works without `this`, so that a caller
 * can pass one function alone.
 */
export type Clock = {
  now(): number
  sleep(ms: number): Promise<void>
  uuid(): string
  /** Calls `tick` each `ms` until the returned function stops it, for example a heartbeat. */
  every(ms: number, tick: () => void): () => void
}

/** The production clock. Each call reads the global when it runs, so that a test mock of Date.now still applies. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  uuid: () => crypto.randomUUID(),
  every(ms, tick) {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  },
}
