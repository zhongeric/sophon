import type { Machine, RepoConfig } from './checks.ts'
import {
  holdoutRefusal,
  runSweepFetches,
  runSweepUnits,
  sweepFetchId,
  unitInputs,
  unitsDir,
  unitsFiles,
  type InputFile,
  type ScanBoxes,
  type SweepJobs,
  type UnitResult,
} from './fanout.ts'
import { step, type Ledger } from './ledger.ts'
import type { Artifacts, DataStore } from './platform.ts'
import { runSweepMerge, runSweepPlan, type DomainOutputs, type PlanUnit } from './research-commands.ts'

/** A clean checkout of the sweep commit for plan and merge. */
export type SweepBox = Machine & { id: string }

/**
 * What one sweep needs from the run. `files` gives the commit files without the holdout file. `check` is the budget
 * gate. `notice` posts the budget notice. `meter` runs a command on a clean box under the compute meter.
 */
export type SweepContext = {
  ledger: Ledger
  config: RepoConfig
  boxes: ScanBoxes
  store: DataStore
  artifacts: Artifacts
  runId: string
  commit: string
  prereg: { hypothesis: string; path: string; sha256: string }
  holdoutTargets: string[]
  /** The size of the unit pool. */
  parallel: number
  cleanBox(key: string, files?: InputFile[]): Promise<SweepBox>
  files(): Promise<InputFile[]>
  check(): Promise<void>
  notice(seconds: number, units: number): Promise<void>
  meter<T>(step: string, box: SweepBox, run: () => Promise<T>): Promise<T>
  log(line: string): void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * The result of one sweep. `plan` is the artifact of the plan output, `table` the artifact of the candidate table
 * (JSON {"candidates": [...]}), null when the sweep failed. `reason` is empty when the sweep passed.
 */
export type SweepResult = {
  plan: string
  units: number
  retries: number
  failedUnits: { id: string; reason: string }[]
  failedTargets: { target: string; reason: string }[]
  trials: number
  table: string | null
  reason: string
}

type Planned = { plan: string; command: string; targets: string[]; units: PlanUnit[]; reason: string }

/**
 * Stage 7 (section 2 of docs/specs/research-workflow.md). A scan box never gets the holdout file or a holdout target
 * (RG1). The trial count is the sum over done units of their target count and their tls_passes (RG5). Each fetch and
 * each unit is a ledger step.
 */
export async function runSweep(context: SweepContext): Promise<SweepResult> {
  const { ledger, config, prereg } = context
  const sweep = config.research?.sweep
  if (!sweep) throw new Error('the research config has no sweep')
  const key = `sweep.${prereg.hypothesis}.${prereg.sha256}`
  const labels = { hypothesis: prereg.hypothesis, command: 'sweep plan' }
  const planned = await step(ledger, `${key}.plan`, async (): Promise<Planned> => {
    const box = await context.cleanBox(`${key}.plan`)
    const run = await context.meter(`${key}.plan`, box, () => runSweepPlan(config, box, prereg.path))
    const plan = await context.artifacts.put(new TextEncoder().encode(run.output), { source: { command: run.command }, media_type: 'text/plain', labels })
    if (run.problem !== null) return { plan, command: run.command, targets: [], units: [], reason: `sweep plan: ${run.problem}` }
    const refused = holdoutRefusal(run.json.targets, context.holdoutTargets)
    if (refused !== null) return { plan, command: run.command, targets: [], units: [], reason: `sweep plan: ${refused}` }
    await context.notice(run.json.units.reduce((sum, unit) => sum + unit.expected_seconds, 0), run.json.units.length)
    return { plan, command: run.command, targets: run.json.targets, units: run.json.units, reason: '' }
  })
  const result: SweepResult = { plan: planned.plan, units: planned.units.length, retries: 0, failedUnits: [], failedTargets: [], trials: 0, table: null, reason: planned.reason }
  if (planned.reason) return result
  if (planned.units.length === 0) return { ...result, table: await table(context, [], 'sweep plan', planned.command) }

  const jobs: SweepJobs = { ledger, boxes: context.boxes, store: context.store, config, runId: context.runId, commit: context.commit, prereg, log: context.log }
  if (context.wait) jobs.wait = context.wait
  if (context.now) jobs.now = context.now
  await context.check()
  const targets = await Promise.all(planned.targets.map(async (target) => ({ target, id: await sweepFetchId(target) })))
  const fetches = await runSweepFetches(targets, sweep.fetch_parallel, context.files, jobs)
  const fetched: Record<string, DomainOutputs> = {}
  for (const fetch of fetches) {
    if (fetch.status === 'done') fetched[fetch.id] = fetch.outputs
    else result.failedTargets.push({ target: fetch.id, reason: fetch.reason ?? '' })
  }
  // A unit with a target whose fetch failed does not start: it fails with the reason of that fetch.
  const blocked = new Map<string, UnitResult>()
  for (const unit of planned.units) {
    const failed = result.failedTargets.find(({ target }) => unit.targets.includes(target))
    if (failed) blocked.set(unit.id, { id: unit.id, status: 'failed', attempts: 0, reason: `the fetch of ${failed.target} failed: ${failed.reason}`, outputs: {} })
  }
  const runnable = planned.units.filter((unit) => !blocked.has(unit.id))
  const ran = await runSweepUnits(runnable, context.parallel, unitInputs(context.files, fetched, context.store), jobs)
  const results = [...ran, ...blocked.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const targetCount = new Map(planned.units.map((unit) => [unit.id, unit.targets.length]))
  result.retries = [...fetches, ...ran].reduce((sum, job) => sum + Math.max(0, job.attempts - 1), 0)
  result.failedUnits = results.flatMap((unit) => (unit.status === 'failed' ? [{ id: unit.id, reason: unit.reason ?? '' }] : []))
  result.trials = results.reduce((sum, unit) => sum + (unit.status === 'done' ? (targetCount.get(unit.id) ?? 0) + (unit.tls_passes ?? 0) : 0), 0)

  await context.check()
  const merged = await step(ledger, `${key}.merge`, async () => {
    const box = await context.cleanBox(`${key}.merge`, await unitsFiles(results, context.store))
    const run = await context.meter(`${key}.merge`, box, () => runSweepMerge(config, box, prereg.path, unitsDir))
    if (run.problem !== null) return { table: null, reason: `sweep merge: ${run.problem}` }
    return { table: await table(context, run.json.candidates, 'sweep merge', run.command), reason: '' }
  })
  return { ...result, ...merged }
}

/** Keeps the candidate table as a run artifact. The same candidates give the same ID. `label` is the step that made the table. */
function table(context: SweepContext, candidates: Record<string, unknown>[], label: 'sweep plan' | 'sweep merge', command: string): Promise<string> {
  const labels = { hypothesis: context.prereg.hypothesis, command: label }
  return context.artifacts.put(new TextEncoder().encode(`${JSON.stringify({ candidates })}\n`), { source: { command }, media_type: 'application/json', labels })
}
