import type { FileSystem } from 'nanocode-ts/bash'
import { artifactId } from './artifacts.ts'
import type { RepoConfig } from './checks.ts'
import { step, type Ledger } from './ledger.ts'
import { PlannedStop } from './planned-stop.ts'
import type { Artifacts } from './platform.ts'
import { pool } from './pool.ts'
import { parseUnitOutput, unitCommand, type DomainOutputs, type PlanUnit, type UnitsManifest } from './research-commands.ts'
import { finishCompute, startCompute, type InstanceSpec } from './usage.ts'

/** A file that the host writes into a unit directory or a checkout, by its path relative to the root. */
export type InputFile = { path: string; data: Uint8Array }

/** The state of the last unit of a slot. `missing`: the box lost the job, for example after its container stopped. */
export type ScanPoll = { state: 'running' } | { state: 'missing' } | { state: 'done'; result: { exit_code: number | null; output: string } }

/**
 * The scan boxes of a platform. A slot is `<pool>/<slot>`, each part [A-Za-z0-9_-]{1,64}, and runs one unit at a time.
 * `instance` is the size of one box for the compute meter, null for the local machine. `maxUnitMs` is the longest time
 * limit of one unit, and `pollMs` is the wait between two polls.
 */
export type ScanBoxes = {
  instance: InstanceSpec | null
  maxUnitMs: number
  pollMs: number
  /** Starts a unit in a clean slot. `full`: no box is free now, so the caller waits and tries again. */
  start(slot: string, unit: { inputs: InputFile[]; command: string; timeoutMs: number }): Promise<{ job: string } | { full: true }>
  poll(slot: string): Promise<ScanPoll>
  kill(slot: string): Promise<void>
  /** The bytes of an output file of the last unit of the slot. */
  read(slot: string, path: string): Promise<Uint8Array>
}

/** The size of the unit pool when the run gives no `parallel`. */
export const defaultUnitParallel = 32

/** A unit starts again on another box at most this many times. Then it fails. */
export const maxRestarts = 3

/** Where merge finds the unit files in its checkout, in place of {units} (UnitsManifest). */
export const unitsDir = '.agent-factory/units'

/** The result of one unit. `outputs` maps each output path to its SHA-256, which is also its artifact ID. */
export type UnitResult = { id: string; status: 'done' | 'failed'; attempts: number; reason?: string; outputs: DomainOutputs }

/** A later result of a unit key with another SHA-256 than the first result. The run keeps the first result. */
export type UnitConflict = { key: string; unit: string; first: string; second: string }

/** One attempt of a unit, recorded before the first poll. `reason` is set when the attempt failed. */
type Attempt = { slot: string; job: string; startedAt: number; reason?: string }

type Outcome = { outputs: DomainOutputs } | { reason: string }

const conflictsKey = 'unit-conflicts'

/** The time limit of one attempt: the smallest of 3 times the expected time, research.timeouts.unit and the box limit. */
export function attemptLimit(expectedSeconds: number, unitTimeoutMs: number | undefined, maxUnitMs: number): number {
  return Math.max(1, Math.floor(Math.min(3 * expectedSeconds * 1000, unitTimeoutMs ?? Number.POSITIVE_INFINITY, maxUnitMs)))
}

/** The reason to refuse a plan, or null. A scan box never gets a target of the holdout file (RG1). */
export function holdoutRefusal(targets: string[], holdout: string[]): string | null {
  const refused = targets.filter((target) => holdout.includes(target))
  return refused.length === 0 ? null : `the plan has the holdout targets ${refused.join(', ')}, but a scan box never gets a holdout target (RG1)`
}

/** A 32-bit FNV-1a hash in hex, so that a long unit ID gives a short slot part that stays different. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

/** The slot of one attempt: the pool part from the run ID, and the slot part from the unit ID and the attempt number. */
export function slotName(runId: string, unitId: string, attempt: number): string {
  const poolPart = runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'run'
  const safe = unitId.replace(/[^A-Za-z0-9_-]/g, '-')
  const slot = `${unitId}-${attempt}`
  return `${poolPart}/${safe === unitId && slot.length <= 64 ? slot : `${safe.slice(0, 40)}-${shortHash(unitId)}-${attempt}`}`
}

/** The SHA-256 of the canonical outputs of a result: the path and hash pairs in path order. */
const resultSha = (outputs: DomainOutputs) =>
  artifactId(new TextEncoder().encode(JSON.stringify(Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))))

/**
 * Records a done result under its unit key and gives the result to use. The first result stays. A later result with
 * another SHA-256 goes into the conflict list of the ledger, for the report.
 */
export async function recordUnitResult(ledger: Ledger, key: string, result: UnitResult): Promise<UnitResult> {
  const sha = await resultSha(result.outputs)
  const recordKey = `unit-result.${key}`
  const first = ledger.get<{ sha: string; result: UnitResult }>(recordKey)
  if (!first) {
    ledger.put(recordKey, { sha, result })
    return result
  }
  const conflicts = unitConflicts(ledger)
  if (first.sha !== sha && !conflicts.some((entry) => entry.key === key && entry.second === sha))
    ledger.put(conflictsKey, [...conflicts, { key, unit: result.id, first: first.sha, second: sha } satisfies UnitConflict])
  return first.result
}

/** Each second result of the run. */
export const unitConflicts = (ledger: Ledger): UnitConflict[] => ledger.get<UnitConflict[]>(conflictsKey) ?? []

/** The plain files of a tree, except the paths of `exclude` and .git, by path relative to the root. */
export async function treeInputs(tree: FileSystem.FileSystem, exclude: string[]): Promise<InputFile[]> {
  const files: InputFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const name of await tree.list(`/${dir}`)) {
      if (name === '.git') continue
      const path = dir === '' ? name : `${dir}/${name}`
      const stat = tree.lstat ? await tree.lstat(`/${path}`) : await tree.stat(`/${path}`)
      if (stat?.kind === 'directory') await walk(path)
      else if (stat?.kind === 'file' && !exclude.includes(path)) files.push({ path, data: await tree.read(`/${path}`) })
    }
  }
  await walk('')
  return files
}

/** The bytes of an artifact. A missing artifact is an error, because the ledger recorded its ID. */
async function artifactBytes(artifacts: Artifacts, id: string, what: string): Promise<Uint8Array> {
  const bytes = await artifacts.get(id)
  if (!bytes) throw new Error(`the artifact ${id} of ${what} is missing`)
  return bytes
}

/** The inputs of a unit: the commit files, and the data files of its targets at their fetch paths, in place of a commit file. */
export function unitInputs(files: () => Promise<InputFile[]>, fetched: Record<string, DomainOutputs>, artifacts: Artifacts): (unit: PlanUnit) => Promise<InputFile[]> {
  return async (unit) => {
    const data = new Map<string, Uint8Array>()
    for (const target of unit.targets)
      for (const [path, sha] of Object.entries(fetched[target] ?? {})) data.set(path, await artifactBytes(artifacts, sha, `fetch ${target} ${path}`))
    return [...(await files()).filter((file) => !data.has(file.path)), ...[...data].map(([path, bytes]) => ({ path, data: bytes }))]
  }
}

/** The files of the units directory for merge: each output file of each done unit, and units.json. */
export async function unitsFiles(results: UnitResult[], artifacts: Artifacts): Promise<InputFile[]> {
  const files: InputFile[] = []
  for (const result of results)
    for (const [path, sha] of Object.entries(result.outputs))
      files.push({ path: `${unitsDir}/${result.id}/${path}`, data: await artifactBytes(artifacts, sha, `unit ${result.id} ${path}`) })
  const manifest: UnitsManifest = {
    units: results.map((result) => ({ id: result.id, status: result.status, attempts: result.attempts, ...(result.reason !== undefined ? { reason: result.reason } : {}) })),
  }
  files.push({ path: `${unitsDir}/units.json`, data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) })
  return files
}

/** What a fan-out of the units of one plan needs. `wait` and `now` replace the timer and the clock in tests. */
export type FanOut = {
  ledger: Ledger
  boxes: ScanBoxes
  artifacts: Artifacts
  config: RepoConfig
  runId: string
  /** The commit of the units, and the frozen prereg and the calibration round that they belong to. */
  commit: string
  prereg: { hypothesis: string; path: string; sha256: string }
  round: number
  parallel: number
  inputs(unit: PlanUnit): Promise<InputFile[]>
  log(line: string): void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

/** The ledger step of one unit. A new commit or a new prereg gives new keys. */
export const unitKey = (fanOut: Pick<FanOut, 'commit' | 'prereg'>, unit: string) => `unit.${fanOut.commit}.${fanOut.prereg.sha256}.${unit}`

/** Runs the units in a pool of `parallel` scan boxes, each unit as a ledger step, and gives the results in plan order. */
export function runUnits(units: PlanUnit[], fanOut: FanOut): Promise<UnitResult[]> {
  return pool(units, fanOut.parallel, (unit) => {
    const key = unitKey(fanOut, unit.id)
    return step(fanOut.ledger, key, () => runUnit(unit, key, fanOut))
  })
}

/**
 * Runs one unit until it is done, or until it failed 1 + maxRestarts times. Over the time limit, a lost box, a non-zero
 * exit, a bad last line and a hash mismatch each fail the attempt, and the next attempt goes to a new slot. A full
 * pool is not an attempt. A replay polls the job of the last recorded attempt and does not start it again.
 */
async function runUnit(unit: PlanUnit, key: string, fanOut: FanOut): Promise<UnitResult> {
  const { ledger, boxes } = fanOut
  const now = fanOut.now ?? Date.now
  const wait = fanOut.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pause = async () => {
    ledger.safePoint?.(boxes.pollMs)
    await wait(boxes.pollMs)
  }
  const attemptsKey = `attempts.${key}`
  const limit = attemptLimit(unit.expected_seconds, fanOut.config.research?.timeouts?.unit, boxes.maxUnitMs)
  const command = unitCommand(fanOut.config, fanOut.prereg.path, unit.id)
  let inputs: InputFile[] | undefined
  for (;;) {
    const attempts = ledger.get<Attempt[]>(attemptsKey) ?? []
    let attempt = attempts.at(-1)
    let number = attempts.length
    if (attempt === undefined || attempt.reason !== undefined) {
      if (attempts.length > maxRestarts)
        return { id: unit.id, status: 'failed', attempts: attempts.length, reason: `${attempts.length} attempts failed. The last reason: ${attempt?.reason ?? ''}`, outputs: {} }
      number = attempts.length + 1
      const slot = slotName(fanOut.runId, unit.id, number)
      inputs ??= await fanOut.inputs(unit)
      let started: { job: string } | { full: true }
      try {
        started = await boxes.start(slot, { inputs, command, timeoutMs: limit })
      } catch (error) {
        const reason = `the start failed: ${message(error)}`
        ledger.put(attemptsKey, [...attempts, { slot, job: '', startedAt: now(), reason } satisfies Attempt])
        fanOut.log(`unit ${unit.id}, attempt ${number}: ${reason}`)
        continue
      }
      if ('full' in started) {
        await pause()
        continue
      }
      attempt = { slot, job: started.job, startedAt: now() }
      ledger.put(attemptsKey, [...attempts, attempt])
      startCompute(ledger, `${key}.${number}`, `unit.${fanOut.prereg.hypothesis}.${fanOut.round}.${unit.id}.${number}`, boxes.instance, attempt.startedAt)
    }
    let outcome: Outcome
    try {
      outcome = await follow(attempt, limit, unit.id, fanOut, now, pause)
    } catch (error) {
      // A planned stop keeps the meter open: the job still runs, and the next call polls it again.
      if (!(error instanceof PlannedStop)) finishCompute(ledger, `${key}.${number}`, now())
      throw error
    }
    finishCompute(ledger, `${key}.${number}`, now())
    if ('outputs' in outcome) return recordUnitResult(ledger, key, { id: unit.id, status: 'done', attempts: number, outputs: outcome.outputs })
    ledger.put(attemptsKey, [...attempts.slice(0, number - 1), { ...attempt, reason: outcome.reason }])
    fanOut.log(`unit ${unit.id}, attempt ${number}: ${outcome.reason}`)
  }
}

/** Polls one attempt until it ends. On exit 0, it checks the last line and keeps each output file as an artifact. */
async function follow(attempt: Attempt, limit: number, id: string, fanOut: FanOut, now: () => number, pause: () => Promise<void>): Promise<Outcome> {
  const { boxes } = fanOut
  for (;;) {
    let polled: ScanPoll
    try {
      polled = await boxes.poll(attempt.slot)
    } catch (error) {
      return { reason: `the poll failed: ${message(error)}` }
    }
    if (polled.state === 'missing') return { reason: `the box of ${attempt.slot} lost the job` }
    if (polled.state === 'running') {
      if (now() - attempt.startedAt <= limit) {
        await pause()
        continue
      }
      try {
        await boxes.kill(attempt.slot)
      } catch (error) {
        fanOut.log(`unit ${id}: the kill of ${attempt.slot} failed: ${message(error)}`)
      }
      return { reason: `the unit ran over its time limit of ${limit} ms` }
    }
    const { exit_code: exitCode, output } = polled.result
    if (exitCode === null) return { reason: `the unit did not finish in its time limit of ${limit} ms` }
    if (exitCode !== 0) return { reason: `the unit exited with code ${exitCode}` }
    const parsed = parseUnitOutput(output)
    if (parsed.problem !== null) return { reason: parsed.problem }
    const outputs: DomainOutputs = {}
    for (const [path, hash] of Object.entries(parsed.json.outputs)) {
      try {
        const bytes = await boxes.read(attempt.slot, path)
        if ((await artifactId(bytes)) !== hash) return { reason: `the unit output ${path} does not match its SHA-256 ${hash}` }
        const labels = { hypothesis: fanOut.prereg.hypothesis, unit: id, round: String(fanOut.round), path }
        const source = { command: unitCommand(fanOut.config, fanOut.prereg.path, id) }
        outputs[path] = await fanOut.artifacts.put(bytes, { source, media_type: 'application/octet-stream', labels })
      } catch (error) {
        return { reason: `the unit output ${path}: ${message(error)}` }
      }
    }
    return { outputs }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
