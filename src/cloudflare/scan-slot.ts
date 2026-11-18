import { boxEnv, readBoxFile, type Box, type JobState } from './box.ts'
import { tar } from './tar.ts'

/** A file that the host copies into the unit directory before the command starts. */
export type UnitInput = { path: string; data: Uint8Array }

/** One search unit: its input files, its command, and the time limit of the command. */
export type Unit = { inputs: UnitInput[]; argv: string[]; timeoutMs: number }

/** What the object keeps about its slot: its name, the job of its last unit, and the time limit of that job. */
export type SlotState = { name: string; job: string; timeoutMs: number }

/** The state of one slot, kept outside the machine. */
export type SlotStore = { read(): SlotState | null; save(state: SlotState): void }

/** The longest time limit of a unit. */
export const maxUnitMs = 6 * 60 * 60_000

/** The margin of the inactivity timeout after the time limit of the last job. */
const idleMs = 10 * 60_000

const copyTimeoutMs = 10 * 60_000

/** The environment of a unit command: boxEnv and the warm numba cache of the scan image (containers/scan/Dockerfile). */
export const scanEnv = { ...boxEnv, NUMBA_CACHE_DIR: '/opt/numba-cache' }

/**
 * The inactivity timeout of a scan box. The job runs detached, and no command renews the timeout between two polls, so
 * the timeout covers all of the time limit of the last job, and a margin.
 */
export function slotInactivityMs(state: SlotState | null): number {
  return (state?.timeoutMs ?? 0) + idleMs
}

// The name parts have no dot, so that the job ID `scan.<pool>.<slot>.<uuid>` of one slot is never the ID of another.
const slotName = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/

/** Refuses an empty or absolute path, and a path with an empty, '.' or '..' part, before any call to the box. */
function checkPath(path: unknown, kind: 'input' | 'output'): string {
  if (typeof path !== 'string' || path.includes('\0') || !path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')) {
    throw new Error(`the ${kind} path ${JSON.stringify(path)} is not a relative path in the unit directory without '.' or '..'`)
  }
  return path
}

/** Refuses a unit that is not valid. The unit comes over RPC, so the check does not trust its type. */
function checkUnit(unit: Unit): void {
  if (!Array.isArray(unit.argv) || unit.argv.length === 0 || !unit.argv.every((arg) => typeof arg === 'string')) throw new Error('the argv of a unit must be a list of strings with at least one item')
  if (!Number.isSafeInteger(unit.timeoutMs) || unit.timeoutMs <= 0 || unit.timeoutMs > maxUnitMs) throw new Error(`the time limit ${unit.timeoutMs} ms of a unit is not an integer from 1 to ${maxUnitMs}`)
  if (!Array.isArray(unit.inputs)) throw new Error('the inputs of a unit must be a list')
  for (const input of unit.inputs) {
    checkPath(input.path, 'input')
    if (!(input.data instanceof Uint8Array)) throw new Error(`the input ${input.path} has no bytes`)
  }
}

/**
 * One slot of a pool of scan boxes, named `<pool>/<slot>`. The slot runs one unit at a time in the directory
 * `scan/<pool>/<slot>`, and keeps only the outputs of its last unit. The directory and the job IDs hold the name,
 * because in local tests all slots share one machine.
 */
export function scanSlot(box: Box, store: SlotStore, name: string) {
  if (!slotName.test(name)) throw new Error(`the slot name ${JSON.stringify(name)} is not <pool>/<slot> with only the characters A-Z, a-z, 0-9, _ and -`)
  const dir = `scan/${name}`
  const current = (): SlotState | null => {
    const state = store.read()
    if (state && state.name !== name) throw new Error(`this object holds the slot ${state.name}, not ${name}`)
    return state
  }
  return {
    /** Starts a unit in a clean unit directory, and refuses it while the job of the last unit runs. */
    async start(unit: Unit): Promise<{ job: string }> {
      checkUnit(unit)
      const last = current()
      if (last) {
        if ((await box.pollJob(last.job)).state === 'running') throw new Error(`the slot ${name} still runs the job ${last.job}: wait for its end, or kill it`)
        await box.killJob(last.job)
      }
      // The test machine refuses an ID that started before, so each unit gets a new one.
      const job = `scan.${name.replace('/', '.')}.${crypto.randomUUID()}`
      // The state comes before the calls below, so that their inactivity timeout covers the new time limit.
      store.save({ job, name, timeoutMs: unit.timeoutMs })
      const archive = tar(unit.inputs.map(({ data, path }) => ({ data, mode: 0o644, path, target: '', type: 'file' as const })))
      const copied = await box.exec(['bash', '-c', 'rm -rf -- "$1" && mkdir -p -- "$1" && tar -x -f - -C "$1"', 'bash', dir], { cwd: '', env: boxEnv, stdin: archive, timeoutMs: copyTimeoutMs })
      if (copied.exit_code !== 0) throw new Error(`the copy of the inputs to ${dir} failed: ${copied.output.slice(-2000)}`)
      await box.startJob(job, unit.argv, { cwd: dir, env: scanEnv, timeoutMs: unit.timeoutMs })
      return { job }
    },
    /** The state of the job of the last unit. A `missing` job, for example after the container stopped, goes to the caller. */
    async poll(): Promise<JobState> {
      const state = current()
      if (!state) throw new Error(`the slot ${name} has no unit`)
      return box.pollJob(state.job)
    },
    async kill(): Promise<void> {
      const state = current()
      if (state) await box.killJob(state.job)
    },
    /** The bytes of an output file of the last unit. */
    async read(path: string): Promise<Uint8Array> {
      checkPath(path, 'output')
      current()
      return readBoxFile(box, dir, path)
    },
  }
}
