import type { Ledger } from '../core/ledger.ts'
import { PausedError } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
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
  /** Starts a new job and waits for its end in this call, with no deadline. */
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
// The cwd and the command, not the pause key: a new copy of a clean box gives a new pause key in the same directory.
const startsKey = (cwd: string, argv: string[]) => `job-starts:${cwd}:${argv.join(' ')}`
/** The most starts of one pause-mode command. A command that kills the machine otherwise starts again with no end. */
const maxStarts = 3
const firstPollMs = 250

/** True when a job needs a kill or file cleanup, so that the end of a run needs the machine only then. */
export const hasOpenJobs = (ledger: Ledger): boolean => (ledger.get<string[]>(openKey) ?? []).length > 0

/** The jobs of one alarm call on `box`, in the ledger of the run. `now` and `sleep` are for tests. */
export function jobRunner(
  box: Box,
  ledger: Ledger,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number } = {},
): JobRunner {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 5_000
  const call = crypto.randomUUID()
  const describe = (record: Pick<JobRecord, 'argv' | 'cwd'>) => `\`${record.argv.join(' ')}\` in ${record.cwd || '/'}`
  const save = (record: JobRecord) => {
    ledger.put(recordKey(record.id), record)
    const open = (ledger.get<string[]>(openKey) ?? []).filter((id) => id !== record.id)
    ledger.put(openKey, record.state === 'open' ? [...open, record.id] : open)
  }
  /** Starts a pause-mode job when `key` is given, else a wait-mode job. */
  const start = async (argv: string[], { cwd, env, timeoutMs }: JobOptions, key?: string) => {
    if (key !== undefined) {
      const starts = ledger.get<number>(startsKey(cwd, argv)) ?? 0
      if (starts >= maxStarts) {
        throw new StopError(`the machine lost the job ${describe({ argv, cwd })} ${maxStarts} times, for example because the command used more memory than the container has`)
      }
      ledger.put(startsKey(cwd, argv), starts + 1)
    }
    const record: JobRecord = { argv, call, cwd, id: `job-${crypto.randomUUID()}`, mode: key === undefined ? 'wait' : 'pause', state: 'open' }
    save(record)
    if (key !== undefined) ledger.put(pauseKey(key), record.id)
    await box.startJob(record.id, argv, { cwd, env, timeoutMs })
    return record
  }
  const cleanup = async (record: JobRecord) => {
    if (!(ledger.get<string[]>(openKey) ?? []).includes(record.id)) return
    await box.killJob(record.id)
    save(record)
  }
  const finish = async (record: JobRecord, result: BoxResult) => {
    const done: JobRecord = { ...record, state: 'done', ...(record.mode === 'pause' ? { result } : {}) }
    // Keep the ID in jobs:open until cleanup ends, so a later call can retry cleanup without a new command.
    ledger.put(recordKey(record.id), done)
    await cleanup(done)
    return result
  }
  const kill = async (record: JobRecord) => {
    await box.killJob(record.id)
    save({ ...record, state: 'killed' })
  }
  const killOpen = async (which: (record: JobRecord) => boolean) => {
    for (const id of ledger.get<string[]>(openKey) ?? []) {
      const record = ledger.get<JobRecord>(recordKey(id))
      if (record?.state === 'done') await cleanup(record)
      else if (record && which(record)) await kill(record)
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
        if (record?.state === 'done' && record.result) {
          await cleanup(record)
          return record.result
        }
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
        } else current = await start(argv, options, key)
        const left = options.deadline - now()
        if (left <= 0) throw new PausedError(`waiting for the job ${describe(current)}`)
        await sleep(Math.min(interval(), left))
      }
    },
    async wait(argv, options) {
      const record = await start(argv, options)
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
