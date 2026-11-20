import type { Ledger } from '../core/ledger.ts'
import { PausedError } from '../core/questions.ts'
import type { Box, BoxResult, JobOptions } from './box.ts'

/**
 * A job in the ledger of the run. The ledger holds it before the job starts, so that a later call finds the job and
 * does not start the command again.
 *
 * - `pause`: a host step. Its key is the same in each call, a later call polls the job, and the record keeps the result.
 * - `wait`: an agent tool call. The call waits for the job, and the next call kills it when the call died first.
 */
export type JobRecord = {
  id: string
  argv: string[]
  cwd: string
  mode: 'pause' | 'wait'
  state: 'open' | 'done' | 'killed'
  /** The runner, that is the alarm call, that started the job. */
  call: string
  result?: BoxResult
}

export type JobRunner = {
  /**
   * Runs the job of `key` one time across calls: gives the result of a finished job, polls a running job, and starts the
   * job again when the machine does not have it. Throws a PausedError at `deadline`, so that a later call polls the job.
   */
  pause(key: string, argv: string[], options: JobOptions & { deadline: number }): Promise<BoxResult>
  /**
   * Starts a new job and waits for its end in this call. With the deadline of the runner, the job ends by then, and no job
   * starts when less than a second is left.
   */
  wait(argv: string[], options: JobOptions): Promise<BoxResult>
  /** Kills the open wait-mode jobs of earlier calls. Call it before an agent turn can run again. */
  killStale(): Promise<void>
  /** Kills all open jobs of the run, for the end of the run. */
  killAll(): Promise<void>
}

// No key starts with step:, output: or report:, because these keys count as progress for callBudget.
const openKey = 'jobs:open'
const recordKey = (id: string) => `job:${id}`
const pauseKey = (key: string) => `job-key:${key}`
// A new copy keeps the start count. Only an explicit error resume gives each command a new retry budget.
const retryBudgetKey = 'jobs:retry-budget'
const startsKey = (ledger: Ledger, cwd: string, argv: string[]) => {
  const budget = ledger.get<number>(retryBudgetKey)
  return `${budget === undefined ? 'job-starts' : `job-starts@${budget}`}:${cwd}:${argv.join(' ')}`
}
const maxPauseStarts = 3
const firstPollMs = 250
/** The shortest timeout of a wait-mode job. With less time left in the call, the job does not start. */
const minWaitMs = 1_000

/** Resets lost-job retries for a restart after an error, by the administrator or by the host (D13), not for the retries of one attempt. */
export function resetJobStarts(ledger: Ledger): void {
  ledger.put(retryBudgetKey, (ledger.get<number>(retryBudgetKey) ?? 0) + 1)
}

/** True when the ledger has a job that is not done or killed, so that the end of a run needs the machine only then. */
export const hasOpenJobs = (ledger: Ledger): boolean => (ledger.get<string[]>(openKey) ?? []).length > 0

/**
 * The jobs of one alarm call on `box`, in the ledger of the run. `deadline` is the end of the call budget: the command
 * of a turn ends by then, so that the agent has time to submit before Cloudflare stops the call (D12). `now` and
 * `sleep` are for tests.
 */
export function jobRunner(
  box: Box,
  ledger: Ledger,
  options: { deadline?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number } = {},
): JobRunner {
  const deadline = options.deadline
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 5_000
  const call = crypto.randomUUID()
  const describe = (record: JobRecord) => `\`${record.argv.join(' ')}\` in ${record.cwd || '/'}`
  const save = (record: JobRecord) => {
    ledger.put(recordKey(record.id), record)
    const open = (ledger.get<string[]>(openKey) ?? []).filter((id) => id !== record.id)
    ledger.put(openKey, record.state === 'open' ? [...open, record.id] : open)
  }
  /** Starts a job. `key` is the pause key of a pause-mode job. */
  const start = async (argv: string[], mode: JobRecord['mode'], { cwd, env, timeoutMs }: JobOptions, key?: string) => {
    const record: JobRecord = { argv, call, cwd, id: `job-${crypto.randomUUID()}`, mode, state: 'open' }
    save(record)
    if (key !== undefined) ledger.put(pauseKey(key), record.id)
    await box.startJob(record.id, argv, { cwd, env, timeoutMs })
    return record
  }
  const finish = (record: JobRecord, result: BoxResult) => {
    save({ ...record, state: 'done', ...(record.mode === 'pause' ? { result } : {}) })
    if (record.mode === 'pause') ledger.put(startsKey(ledger, record.cwd, record.argv), 0)
    return result
  }
  const kill = async (record: JobRecord) => {
    await box.killJob(record.id)
    save({ ...record, state: 'killed' })
  }
  const killOpen = async (which: (record: JobRecord) => boolean) => {
    for (const id of ledger.get<string[]>(openKey) ?? []) {
      const record = ledger.get<JobRecord>(recordKey(id))
      if (record && which(record)) await kill(record)
    }
  }
  /** The waits between polls: short at first, so that a short command ends soon, then `pollMs`. */
  const backoff = () => {
    let next = firstPollMs
    return () => {
      const ms = Math.min(next, pollMs)
      next *= 2
      return ms
    }
  }
  return {
    async pause(key, argv, options) {
      const interval = backoff()
      for (;;) {
        const id = ledger.get<string>(pauseKey(key))
        const record = id === undefined ? undefined : ledger.get<JobRecord>(recordKey(id))
        if (record?.state === 'done' && record.result) return record.result
        let current: JobRecord
        if (record?.state === 'open') {
          const polled = await box.pollJob(record.id)
          if (polled.state === 'done') return finish(record, polled.result)
          // The next loop starts the job again, after the kill of what is left of it.
          if (polled.state === 'missing') {
            await kill(record)
            continue
          }
          current = record
        } else {
          // A PausedError does not count as a failed attempt, so this limit stops a job that the machine loses each time.
          const starts = ledger.get<number>(startsKey(ledger, options.cwd, argv)) ?? 0
          if (starts >= maxPauseStarts) throw new Error(`the machine lost the job \`${argv.join(' ')}\` in ${options.cwd || '/'} ${starts} times, for example on the memory limit of the container`)
          ledger.put(startsKey(ledger, options.cwd, argv), starts + 1)
          current = await start(argv, 'pause', options, key)
        }
        const left = options.deadline - now()
        if (left <= 0) throw new PausedError(`waiting for the job ${describe(current)}`)
        await sleep(Math.min(interval(), left))
      }
    },
    async wait(argv, options) {
      const left = deadline === undefined ? Infinity : deadline - now()
      if (left < minWaitMs) return { exit_code: null, output: '[host] not started: the alarm call has no time left for this command' }
      const record = await start(argv, 'wait', { ...options, timeoutMs: Math.min(options.timeoutMs, left) })
      const interval = backoff()
      for (;;) {
        await sleep(interval())
        const polled = await box.pollJob(record.id)
        if (polled.state === 'done') return finish(record, polled.result)
        if (polled.state === 'missing') {
          await kill(record)
          throw new Error(`the job ${describe(record)} is not in the machine, for example because the machine started again`)
        }
      }
    },
    killStale: () => killOpen((record) => record.mode === 'wait' && record.call !== call),
    killAll: () => killOpen(() => true),
  }
}
