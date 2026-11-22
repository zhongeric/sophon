import type { FileSystem } from 'nanocode-ts/bash'
import { artifactId } from './artifacts.ts'
import { commandOptions, type RepoConfig } from './checks.ts'
import { step, type Ledger } from './ledger.ts'
import { PlannedStop } from './planned-stop.ts'
import type { Artifacts, DataStore } from './platform.ts'
import { pool } from './pool.ts'
import {
  parseSweepFetchOutput,
  parseSweepUnitOutput,
  parseUnitOutput,
  sweepFetchCommand,
  sweepUnitCommand,
  unitCommand,
  type DomainOutputs,
  type PlanUnit,
  type UnitsManifest,
} from './research-commands.ts'
import { finishCompute, startCompute, type InstanceSpec } from './usage.ts'

/** A file that the host writes into a unit directory or a checkout, by its path relative to the root. It has no mode, so it is not executable. */
export type InputFile = { path: string; data: Uint8Array }

/**
 * The state of the last unit of a slot. `missing`: the box lost the job, for example after its container stopped.
 * `ended_at`: the end of the job in ms since the epoch, when the box keeps it, so that a late poll does not add seconds.
 */
export type ScanPoll = { state: 'running' } | { state: 'missing' } | { state: 'done'; result: { exit_code: number | null; output: string; ended_at?: number } }

/**
 * The scan boxes of a platform. A slot is `<pool>/<slot>`, each part [A-Za-z0-9_-]{1,64}, and runs one unit at a time.
 * `instance` is the size of one box for the compute meter, null for the local machine. `maxUnitMs` is the longest time
 * limit of one unit, and `pollMs` is the wait between two polls.
 */
export type ScanBoxes = {
  instance: InstanceSpec | null
  maxUnitMs: number
  pollMs: number
  /** True when a job started with `egress: true` gets AGENT_FACTORY_EGRESS, the base URL of the host egress proxy. */
  egress?: boolean
  /** Starts a unit in a clean slot, after the end of the last job of the slot. `full`: no box is free now, so the caller waits and tries again. */
  start(slot: string, unit: { inputs: InputFile[]; command: string; timeoutMs: number; egress?: true }): Promise<{ job: string } | { full: true }>
  poll(slot: string): Promise<ScanPoll>
  kill(slot: string): Promise<void>
  /** The bytes of an output file of the last unit of the slot. */
  read(slot: string, path: string): Promise<Uint8Array>
}

/** The size of the unit pool when the run gives no `parallel`. */
export const defaultUnitParallel = 32

/** A unit starts again on another box at most this many times. Then it fails. */
const maxRestarts = 3

/** Where merge finds the unit files in its checkout, in place of {units} (UnitsManifest). */
export const unitsDir = '.agent-factory/units'

/**
 * The result of one job: a unit, or a sweep fetch with the target as its ID. `outputs` maps each output path to its
 * SHA-256, which is also its ID in the store. Only a done sweep unit has `tls_passes`.
 */
export type UnitResult = { id: string; status: 'done' | 'failed'; attempts: number; reason?: string; outputs: DomainOutputs; tls_passes?: number }

/** A later result of a unit key with another SHA-256 than the first result. The run keeps the first result. */
export type UnitConflict = { key: string; unit: string; first: string; second: string }

/**
 * One attempt of a unit, recorded before the first poll. `seenAt`: the last poll that saw the job run, kept at most once
 * a minute. `reason` marks a failure. `alive` keeps its slot busy.
 */
type Attempt = { slot: string; startedAt: number; seenAt?: number; reason?: string; alive?: true }

/** `endedAt`: the end of the job that the box gave. `alive`: the kill of the job failed, so the job can still run. */
type Outcome = ({ outputs: DomainOutputs; tls_passes?: number } | { reason: string }) & { endedAt?: number; alive?: true }

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

/**
 * The slot of one attempt: the pool part from the run ID, and the slot part from the unit ID and the attempt number. A
 * plan unit ID matches [A-Za-z0-9_-]{1,64} (planJson), so only a long slot part needs the hash.
 */
export function slotName(runId: string, unitId: string, attempt: number): string {
  return poolSlot(poolPart(runId), unitId, attempt)
}

function poolSlot(pool: string, id: string, attempt: number): string {
  const slot = `${id}-${attempt}`
  return `${pool}/${slot.length <= 64 ? slot : `${id.slice(0, 40)}-${shortHash(id)}-${attempt}`}`
}

/**
 * The slot of a lane of the pool. A first attempt runs in a free lane, so that the next unit uses the same box and a
 * pool of `parallel` units keeps at most `parallel` lane boxes. The slot part has no '-', so a retry slot is never a lane.
 */
function laneName(pool: string, lane: number): string {
  return `${pool}/lane_${lane}`
}

const poolPart = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'run'

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

/** Keep each symlink target so that fetched data also replaces the bytes of its aliases. */
type TreeInputFile = InputFile & { linkedPaths?: string[] }

/**
 * The files of a tree, except the paths of `exclude` and .git, by path relative to the root. A symlink to a file of the
 * tree gives the bytes of that file. Another symlink is an error, because the unit would not see the checkout of the run box.
 */
export async function treeInputs(tree: FileSystem.FileSystem, exclude: string[]): Promise<TreeInputFile[]> {
  const files: TreeInputFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const name of await tree.list(`/${dir}`)) {
      if (name === '.git') continue
      const path = dir === '' ? name : `${dir}/${name}`
      const stat = tree.lstat ? await tree.lstat(`/${path}`) : await tree.stat(`/${path}`)
      if (stat?.kind === 'directory') await walk(path)
      else if (exclude.includes(path)) continue
      else if (stat?.kind === 'file') files.push({ path, data: await tree.read(`/${path}`) })
      else if (stat?.kind === 'symlink') {
        const target = await linkedFile(tree, path)
        if (target === null) throw new Error(`the commit has the symlink ${path}, but a unit gets only a symlink to a file of the commit`)
        if (!exclude.includes(target.path)) files.push({ path, data: await tree.read(`/${target.path}`), linkedPaths: target.links })
      }
    }
  }
  await walk('')
  return files
}

/** The file path and the symlink targets, or null if the chain leaves the tree or ends at no file. */
async function linkedFile(tree: FileSystem.FileSystem, path: string): Promise<{ path: string; links: string[] } | null> {
  let current = path
  const links: string[] = []
  for (let hop = 0; hop < 40; hop++) {
    const target = await tree.readlink?.(`/${current}`)
    if (!target || target.startsWith('/')) return null
    const parts = current.split('/').slice(0, -1)
    for (const part of target.split('/')) {
      if (part === '..') {
        if (parts.pop() === undefined) return null
      } else if (part !== '' && part !== '.') parts.push(part)
    }
    current = parts.join('/')
    if (parts.length === 0 || parts[0] === '.git') return null
    links.push(current)
    const stat = tree.lstat ? await tree.lstat(`/${current}`) : null
    if (stat?.kind === 'file') return { path: current, links }
    if (stat?.kind !== 'symlink') return null
  }
  return null
}

/** The bytes of an artifact. A missing artifact is an error, because the ledger recorded its ID. */
async function artifactBytes(artifacts: Pick<Artifacts, 'get'>, id: string, what: string): Promise<Uint8Array> {
  const bytes = await artifacts.get(id)
  if (!bytes) throw new Error(`the artifact ${id} of ${what} is missing`)
  return bytes
}

/** The inputs of a unit: the commit files, and the data files of its targets at their fetch paths, in place of a commit file. */
export function unitInputs(files: () => Promise<TreeInputFile[]>, fetched: Record<string, DomainOutputs>, artifacts: Pick<Artifacts, 'get'>): (unit: PlanUnit) => Promise<InputFile[]> {
  return async (unit) => {
    const data = new Map<string, Uint8Array>()
    for (const target of unit.targets)
      for (const [path, sha] of Object.entries(fetched[target] ?? {})) data.set(path, await artifactBytes(artifacts, sha, `fetch ${target} ${path}`))
    const commitFiles = (await files()).filter((file) => !data.has(file.path)).map((file) => {
      const replacement = file.linkedPaths?.find((path) => data.has(path))
      return { path: file.path, data: (replacement === undefined ? undefined : data.get(replacement)) ?? file.data }
    })
    return [...commitFiles, ...[...data].map(([path, bytes]) => ({ path, data: bytes }))]
  }
}

/** The units.json of merge, also kept in the calibration round for the report. */
export function unitsManifest(results: UnitResult[]): UnitsManifest {
  return { units: results.map((result) => ({ id: result.id, status: result.status, attempts: result.attempts, ...(result.reason !== undefined ? { reason: result.reason } : {}) })) }
}

/** The files of the units directory for merge: each output file of each done unit, and units.json. */
export async function unitsFiles(results: UnitResult[], artifacts: Pick<Artifacts, 'get'>): Promise<InputFile[]> {
  const files: InputFile[] = []
  for (const result of results)
    for (const [path, sha] of Object.entries(result.outputs))
      files.push({ path: `${unitsDir}/${result.id}/${path}`, data: await artifactBytes(artifacts, sha, `unit ${result.id} ${path}`) })
  const manifest = unitsManifest(results)
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
  const lanes = jobLanes(units.map((unit) => unitKey(fanOut, unit.id)), poolPart(fanOut.runId), fanOut.ledger)
  return runJobs(units, fanOut.parallel, fanOut, lanes, (unit) => {
    const command = unitCommand(fanOut.config, fanOut.prereg.path, unit.id)
    return {
      id: unit.id,
      name: unit.id,
      kind: 'unit',
      key: unitKey(fanOut, unit.id),
      meter: (number) => `unit.${fanOut.prereg.hypothesis}.${fanOut.round}.${unit.id}.${number}`,
      limit: attemptLimit(unit.expected_seconds, fanOut.config.research?.timeouts?.unit, fanOut.boxes.maxUnitMs),
      command,
      retrySlot: (number) => slotName(fanOut.runId, unit.id, number),
      inputs: () => fanOut.inputs(unit),
      parse: parseUnitOutput,
      keep: (path, bytes) => {
        const labels = { hypothesis: fanOut.prereg.hypothesis, unit: unit.id, round: String(fanOut.round), path }
        return fanOut.artifacts.put(bytes, { source: { command }, media_type: 'application/octet-stream', labels })
      },
    }
  })
}

/**
 * What the jobs of one stage 7 sweep need. The data files of the fetches and of the units go to `store`, not to the
 * artifacts (RG3). `wait` and `now` replace the timer and the clock in tests.
 */
export type SweepJobs = {
  ledger: Ledger
  boxes: ScanBoxes
  store: DataStore
  config: RepoConfig
  runId: string
  commit: string
  prereg: { hypothesis: string; path: string; sha256: string }
  log(line: string): void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

/** One sweep fetch. `id` is the part of its slot names and of its ledger key (sweepFetchId). */
export type SweepTarget = { target: string; id: string }

/**
 * The job ID of the sweep fetch of a target: stable, different for each target, and valid in a slot name for any
 * target name. It has no '-', so a retry slot is never a lane.
 */
export const sweepFetchId = async (target: string): Promise<string> => `t_${(await artifactId(new TextEncoder().encode(target))).slice(0, 32)}`

/** The ledger steps of the sweep. They differ from the stage 6 keys, and a new commit or a new prereg gives new keys. */
export const sweepFetchKey = (sweep: Pick<SweepJobs, 'commit' | 'prereg'>, id: string) => `sweep-fetch.${sweep.commit}.${sweep.prereg.sha256}.${id}`
export const sweepUnitKey = (sweep: Pick<SweepJobs, 'commit' | 'prereg'>, unit: string) => `sweep-unit.${sweep.commit}.${sweep.prereg.sha256}.${unit}`

/** The pool parts of the sweep. Fetch slots and unit slots differ, so a box that ran an egress job never runs a unit. */
const sweepPool = (runId: string, kind: 'fetch' | 'unit') => `${poolPart(runId).slice(0, 58)}-${kind === 'fetch' ? 'fetch' : 'sweep'}`

/**
 * Runs the sweep fetch of each target in a pool of `parallel` scan boxes with egress, each fetch as a ledger step, and
 * gives the results in target order. A result has the target name as its ID. The time limit is research.timeouts.fetch,
 * else the timeout of the checks, and at most the box limit.
 */
export function runSweepFetches(targets: SweepTarget[], parallel: number, inputs: () => Promise<InputFile[]>, sweep: SweepJobs): Promise<UnitResult[]> {
  const slots = sweepPool(sweep.runId, 'fetch')
  const lanes = jobLanes(targets.map((target) => sweepFetchKey(sweep, target.id)), slots, sweep.ledger)
  const timeout = sweep.config.research?.timeouts?.fetch ?? commandOptions(sweep.config).timeoutMs
  return runJobs(targets, parallel, sweep, lanes, ({ target, id }) => ({
    id,
    name: target,
    kind: 'fetch',
    key: sweepFetchKey(sweep, id),
    meter: (number) => `sweep-fetch.${sweep.prereg.hypothesis}.${id}.${number}`,
    limit: Math.max(1, Math.min(timeout, sweep.boxes.maxUnitMs)),
    command: sweepFetchCommand(sweep.config, sweep.prereg.path, target),
    egress: true,
    retrySlot: (number) => poolSlot(slots, id, number),
    inputs,
    parse: parseSweepFetchOutput,
    keep: (_path, bytes) => sweep.store.put(bytes),
  }))
}

/** Runs the sweep units in a pool of `parallel` scan boxes without egress, as runUnits, and keeps their tls_passes. */
export function runSweepUnits(units: PlanUnit[], parallel: number, inputs: (unit: PlanUnit) => Promise<InputFile[]>, sweep: SweepJobs): Promise<UnitResult[]> {
  const slots = sweepPool(sweep.runId, 'unit')
  const lanes = jobLanes(units.map((unit) => sweepUnitKey(sweep, unit.id)), slots, sweep.ledger)
  return runJobs(units, parallel, sweep, lanes, (unit) => ({
    id: unit.id,
    name: unit.id,
    kind: 'unit',
    key: sweepUnitKey(sweep, unit.id),
    meter: (number) => `sweep-unit.${sweep.prereg.hypothesis}.${unit.id}.${number}`,
    limit: attemptLimit(unit.expected_seconds, sweep.config.research?.timeouts?.unit, sweep.boxes.maxUnitMs),
    command: sweepUnitCommand(sweep.config, sweep.prereg.path, unit.id),
    retrySlot: (number) => poolSlot(slots, unit.id, number),
    inputs: () => inputs(unit),
    parse: parseSweepUnitOutput,
    keep: (_path, bytes) => sweep.store.put(bytes),
  }))
}

/** What each job of a pool needs from the run. */
type Runner = Pick<FanOut, 'ledger' | 'boxes' | 'log' | 'wait' | 'now'>

/**
 * One job on a scan box: a stage 6 unit, a sweep fetch or a sweep unit. `id` is the part of its slot names, `name` the
 * name in its result and its log lines. `meter` gives the step name of an attempt for the compute meter. `keep` stores
 * one output file and gives its ID, the SHA-256 of the bytes.
 */
type Job = {
  id: string
  name: string
  kind: 'unit' | 'fetch'
  key: string
  meter(number: number): string
  limit: number
  command: string
  egress?: true
  retrySlot(number: number): string
  inputs(): Promise<InputFile[]>
  parse(output: string): { json: { outputs: DomainOutputs; tls_passes?: number }; problem: null } | { json: null; problem: string }
  keep(path: string, bytes: Uint8Array): Promise<string>
}

/** Runs the jobs of the items in a pool of `parallel`, each job as a ledger step, and gives the results in item order. */
function runJobs<T>(items: T[], parallel: number, runner: Runner, lanes: Lanes, job: (item: T) => Job): Promise<UnitResult[]> {
  return pool(items, parallel, (item) => {
    const spec = job(item)
    return step(runner.ledger, spec.key, () => runJob(spec, runner, lanes))
  })
}

type Lanes = { take(): string; free(slot: string): void }

/**
 * The lanes of one pool of jobs. A lane stays busy until its job ends. A resume also keeps the slots of failed kills busy,
 * even when a later attempt finished.
 */
function jobLanes(keys: string[], pool: string, ledger: Ledger): Lanes {
  const busy = new Set<string>()
  for (const key of keys) {
    const attempts = ledger.get<Attempt[]>(`attempts.${key}`) ?? []
    for (const attempt of attempts) if (attempt.alive) busy.add(attempt.slot)
    const last = attempts.at(-1)
    if (last && last.reason === undefined && !ledger.get(`unit-result.${key}`)) busy.add(last.slot)
  }
  return {
    take() {
      for (let lane = 0; ; lane++) {
        const slot = laneName(pool, lane)
        if (busy.has(slot)) continue
        busy.add(slot)
        return slot
      }
    },
    free: (slot) => void busy.delete(slot),
  }
}

/**
 * Runs one job until it is done, or until it failed 1 + maxRestarts times. Over the time limit, a lost box, a non-zero
 * exit, a bad last line and a hash mismatch each fail the attempt. The first attempt runs in a lane, and each next attempt
 * goes to a new slot. A full pool is not an attempt. A replay polls the job of the last recorded attempt and does not
 * start it again.
 */
async function runJob(job: Job, runner: Runner, lanes: Lanes): Promise<UnitResult> {
  const { ledger, boxes } = runner
  const now = runner.now ?? Date.now
  const wait = runner.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pause = async () => {
    ledger.safePoint?.(boxes.pollMs)
    await wait(boxes.pollMs)
  }
  const { key } = job
  const attemptsKey = `attempts.${key}`
  let inputs: InputFile[] | undefined
  let lane: string | undefined
  for (;;) {
    const attempts = ledger.get<Attempt[]>(attemptsKey) ?? []
    let attempt = attempts.at(-1)
    let number = attempts.length
    if (attempt === undefined || attempt.reason !== undefined) {
      if (attempts.length > maxRestarts)
        return { id: job.name, status: 'failed', attempts: attempts.length, reason: `${attempts.length} attempts failed. The last reason: ${attempt?.reason ?? ''}`, outputs: {} }
      number = attempts.length + 1
      const slot = number === 1 ? (lane ??= lanes.take()) : job.retrySlot(number)
      inputs ??= await job.inputs()
      let started: { job: string } | { full: true }
      try {
        started = await boxes.start(slot, { inputs, command: job.command, timeoutMs: job.limit, ...(job.egress ? { egress: true as const } : {}) })
      } catch (error) {
        const reason = `the start failed: ${message(error)}`
        // The box can start the job before the error.
        const alive = !(await kill(runner, job, slot))
        if (!alive) lanes.free(slot)
        ledger.put(attemptsKey, [...attempts, { slot, startedAt: now(), reason, ...(alive ? { alive: true as const } : {}) } satisfies Attempt])
        runner.log(`${job.kind} ${job.name}, attempt ${number}: ${reason}`)
        continue
      }
      if ('full' in started) {
        await pause()
        continue
      }
      attempt = { slot, startedAt: now() }
      ledger.put(attemptsKey, [...attempts, attempt])
      startCompute(ledger, `${key}.${number}`, job.meter(number), boxes.instance, attempt.startedAt)
    }
    const current = attempt
    const seen = (at: number) => ledger.put(attemptsKey, [...attempts.slice(0, number - 1), { ...current, seenAt: at } satisfies Attempt])
    let outcome: Outcome
    try {
      outcome = await follow(attempt, job, runner, now, pause, seen)
    } catch (error) {
      // A planned stop keeps the meter open: the job still runs, and the next call polls it again.
      if (!(error instanceof PlannedStop)) finishCompute(ledger, `${key}.${number}`, now())
      throw error
    }
    // A job ends after its start and before this poll, also when the clock of the box is not the clock of the host.
    finishCompute(ledger, `${key}.${number}`, Math.min(now(), Math.max(attempt.startedAt, outcome.endedAt ?? now())))
    if (!outcome.alive) lanes.free(attempt.slot)
    if ('outputs' in outcome) {
      const passes = outcome.tls_passes === undefined ? {} : { tls_passes: outcome.tls_passes }
      return recordUnitResult(ledger, key, { id: job.name, status: 'done', attempts: number, outputs: outcome.outputs, ...passes })
    }
    ledger.put(attemptsKey, [...attempts.slice(0, number - 1), { ...attempt, reason: outcome.reason, ...(outcome.alive ? { alive: true } : {}) }])
    runner.log(`${job.kind} ${job.name}, attempt ${number}: ${outcome.reason}`)
  }
}

/**
 * Polls one attempt until it ends. On exit 0, it checks the last line and keeps each output file with `keep`. A lost
 * job ends at the last poll that saw it run, so that the time before a resume does not count as compute.
 */
async function follow(attempt: Attempt, job: Job, runner: Runner, now: () => number, pause: () => Promise<void>, seen: (at: number) => void): Promise<Outcome> {
  const { boxes } = runner
  const { limit, kind } = job
  let seenAt = attempt.seenAt ?? attempt.startedAt
  let keptAt = seenAt
  for (;;) {
    let polled: ScanPoll
    try {
      polled = await boxes.poll(attempt.slot)
    } catch (error) {
      return stop(runner, job, attempt.slot, `the poll failed: ${message(error)}`)
    }
    if (polled.state === 'missing') return { reason: `the box of ${attempt.slot} lost the job`, endedAt: seenAt }
    if (polled.state === 'running') {
      seenAt = now()
      if (seenAt - keptAt >= 60_000) {
        seen(seenAt)
        keptAt = seenAt
      }
      if (now() - attempt.startedAt <= limit) {
        await pause()
        continue
      }
      return stop(runner, job, attempt.slot, `the ${kind} ran over its time limit of ${limit} ms`)
    }
    const { exit_code: exitCode, output, ended_at: endedAt } = polled.result
    const ended = endedAt === undefined ? {} : { endedAt }
    if (exitCode === null) return { reason: `the ${kind} did not finish in its time limit of ${limit} ms`, ...ended }
    if (exitCode !== 0) return { reason: `the ${kind} exited with code ${exitCode}`, ...ended }
    const parsed = job.parse(output)
    if (parsed.problem !== null) return { reason: parsed.problem, ...ended }
    const outputs: DomainOutputs = {}
    for (const [path, hash] of Object.entries(parsed.json.outputs)) {
      try {
        const bytes = await boxes.read(attempt.slot, path)
        if ((await artifactId(bytes)) !== hash) return { reason: `the ${kind} output ${path} does not match its SHA-256 ${hash}`, ...ended }
        outputs[path] = await job.keep(path, bytes)
      } catch (error) {
        return { reason: `the ${kind} output ${path}: ${message(error)}`, ...ended }
      }
    }
    const passes = parsed.json.tls_passes === undefined ? {} : { tls_passes: parsed.json.tls_passes }
    return { outputs, ...passes, ...ended }
  }
}

/** Kills the job of a slot as a best-effort step: a failed kill goes to the log and gives false. */
async function kill(runner: Runner, job: Job, slot: string): Promise<boolean> {
  try {
    await runner.boxes.kill(slot)
    return true
  } catch (error) {
    runner.log(`${job.kind} ${job.name}: the kill of ${slot} failed: ${message(error)}`)
    return false
  }
}

/** Kills the job of a failed attempt. */
async function stop(runner: Runner, job: Job, slot: string, reason: string): Promise<Outcome> {
  return (await kill(runner, job, slot)) ? { reason } : { reason, alive: true }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
