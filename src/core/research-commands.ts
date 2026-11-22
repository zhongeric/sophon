import { commandOptions, quote, setupOnce, type Machine, type RepoConfig } from './checks.ts'
import { fillCommand, type ResearchConfig } from './research.ts'

/** The domain commands of stages 6 and 11 (section 6.3 of docs/specs/research-workflow.md). */
export type DomainCommand = 'known' | 'inject' | 'reproduce' | 'analyze'

/** The outputs of a domain command: path to the lowercase SHA-256 hex of its bytes. */
export type DomainOutputs = Record<string, string>

/**
 * The last line of a domain command. Only known gives a recall. Only known and inject give reads: the path prefixes that
 * they read, in the form of git paths (readsPrefix). reads is null when the command does not give it.
 */
export type DomainJson = { recall: number | null; outputs: DomainOutputs; reads: string[] | null }

/** One run of a domain command. `problem` is set exactly when the run failed or its last line is not valid. */
export type DomainRun = { name: DomainCommand; command: string; exit_code: number | null; output: string } & (
  | { json: DomainJson; problem: null }
  | { json: null; problem: string }
)

/**
 * One run of plan or fetch. `problem` and `tail` are set exactly when the run failed or its last line is not valid.
 * `tail` is the end of the output under a line that names the command, as in a failed calibration.
 */
export type CommandRun<Name extends string, Json> = { name: Name; command: string; exit_code: number | null; output: string } & (
  | { json: Json; problem: null }
  | { json: null; problem: string; tail: string }
)

/** One unit of a plan. The ID is a part of a scan slot name and a directory name. */
export type PlanUnit = { id: string; targets: string[]; expected_seconds: number }

/** The last line of plan: the targets to fetch and the units that use them. */
export type Plan = { targets: string[]; units: PlanUnit[] }

export type PlanRun = CommandRun<'plan', Plan>

/** The last line of fetch and of unit: the data files that they write, by path relative to the checkout. */
export type FileOutputs = { outputs: DomainOutputs }

export type FetchRun = CommandRun<'fetch', FileOutputs>

/**
 * The manifest of the units directory that merge reads in place of {units}:
 * - `<units>/<unit id>/<output path>`: each output file of each done unit.
 * - `<units>/units.json`: this manifest, with each unit of the plan. `reason` tells why a failed unit failed.
 */
export type UnitsManifest = { units: { id: string; status: 'done' | 'failed'; attempts: number; reason?: string }[] }

export type Calibration = { recall: number | null; threshold: number; outputs: DomainOutputs } & (
  | { pass: true }
  | { pass: false; reason: string; tail: string }
)

export type AnalysisVerdict = { outputs: DomainOutputs } & ({ pass: true } | { pass: false; reason: string; tail: string })

export type HashMismatch = { path: string; expected: string; actual: string }

export type Reproduction = { mismatches: HashMismatch[]; missing: string[] } & ({ pass: true } | { pass: false; reason: string; tail: string })

/** The output tail that a failure gives to the builder and to the report. */
const failureTailChars = 4_000

const sha256Hex = /^[0-9a-f]{64}$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The setup of each machine, as in commandChecker. */
const setups = new WeakMap<Machine, () => Promise<{ exit_code: number | null; output: string } | null>>()

const exitProblem = (what: string, exitCode: number | null) =>
  exitCode === null ? `${what} did not finish: it timed out or the host stopped it` : `${what} exited with code ${exitCode}`

/**
 * A reads prefix in the form of git paths, so that needsRecalibration can compare it with changed paths: no leading
 * slash and no empty, . or .. segments. It is null when it is not a string, is the repository root, or is outside it.
 */
function readsPrefix(item: unknown): string | null {
  if (typeof item !== 'string') return null
  const parts = item.trim().split('/')
  const segments: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part !== '..') segments.push(part)
    else if (segments.pop() === undefined) return null
  }
  if (segments.length === 0) return null
  return ['', '.', '..'].includes(parts.at(-1)!) ? `${segments.join('/')}/` : segments.join('/')
}

type Parsed<Json> = { json: Json; problem: null } | { json: null; problem: string }

/** Parses the last non-empty line of the output as a JSON object with `parse`, which puts each problem into `problems`. */
function parseLastLine<Json>(name: string, output: string, parse: (value: Record<string, unknown>, problems: string[]) => Json): Parsed<Json> {
  const line = output.split('\n').map((item) => item.trim()).filter((item) => item !== '').at(-1)
  if (line === undefined) return { json: null, problem: `${name} printed nothing, but its last line must be a JSON object` }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { json: null, problem: `the last line of ${name} is not JSON` }
  }
  if (!isObject(value)) return { json: null, problem: `the last line of ${name} is not a JSON object` }
  const problems: string[] = []
  const json = parse(value, problems)
  if (problems.length > 0) return { json: null, problem: `the last line of ${name}: ${problems.join(', ')}` }
  return { json, problem: null }
}

/**
 * The outputs of a last line. With `files`, each path must also be relative to the checkout without . or .. segments,
 * because the host writes the file at that path.
 */
function parseOutputs(value: unknown, problems: string[], files = false): DomainOutputs {
  const outputs: DomainOutputs = {}
  if (!isObject(value)) problems.push('outputs must be an object of path to SHA-256 hex')
  else
    for (const [path, hash] of Object.entries(value)) {
      if (path.trim() === '') problems.push('an output path is empty')
      else if (files && (path.includes('\\') || path.split('/').some((segment) => ['', '.', '..'].includes(segment))))
        problems.push(`the output path ${path} must be relative, with / and without empty, . or .. segments`)
      else if (typeof hash !== 'string' || !sha256Hex.test(hash.toLowerCase())) problems.push(`the hash of ${path} is not SHA-256 hex`)
      else outputs[path] = hash.toLowerCase()
    }
  return outputs
}

/** The DomainJson of one object by the contract of the command. Each problem goes into `problems`. */
function domainJson(name: DomainCommand, value: Record<string, unknown>, problems: string[]): DomainJson {
  let recall: number | null = null
  if (name === 'known') {
    if (typeof value.recall === 'number' && Number.isFinite(value.recall) && value.recall >= 0 && value.recall <= 1) recall = value.recall
    else problems.push('recall must be a number from 0 to 1')
  }
  let reads: string[] | null = null
  if ((name === 'known' || name === 'inject') && value.reads !== undefined) {
    const items: (string | null)[] = Array.isArray(value.reads) ? value.reads.map(readsPrefix) : [null]
    const prefixes = items.filter((item): item is string => item !== null)
    if (prefixes.length < items.length) problems.push('reads must be a list of non-empty path prefixes in the repository')
    else reads = prefixes
  }
  return { recall, outputs: parseOutputs(value.outputs, problems), reads }
}

const unitId = /^[A-Za-z0-9_-]{1,64}$/

/** A list of non-empty strings without repeats, or null with the problem in `problems`. */
function names(value: unknown, key: string, problems: string[]): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    problems.push(`${key} must be a list of non-empty strings`)
    return null
  }
  const repeated = value.filter((item, index) => value.indexOf(item) !== index)
  if (repeated.length > 0) problems.push(`${key} repeats ${[...new Set(repeated)].join(', ')}`)
  return value
}

/** The Plan of the last line of plan. Each problem goes into `problems`. */
function planJson(value: Record<string, unknown>, problems: string[]): Plan {
  const targets = names(value.targets, 'targets', problems) ?? []
  const units: PlanUnit[] = []
  const ids = new Set<string>()
  if (!Array.isArray(value.units)) problems.push('units must be a list')
  else
    for (const [index, item] of value.units.entries()) {
      const at = `units[${index}]`
      if (!isObject(item)) {
        problems.push(`${at} must be an object`)
        continue
      }
      const { id, expected_seconds: seconds } = item
      if (typeof id !== 'string' || !unitId.test(id)) problems.push(`${at}.id must match ${unitId.source}, because it is a part of a scan slot name and a directory name`)
      else if (ids.has(id)) problems.push(`${at}.id repeats the unit ID ${id}`)
      else ids.add(id)
      const unitTargets = names(item.targets, `${at}.targets`, problems)
      const unknown = (unitTargets ?? []).filter((target) => !targets.includes(target))
      if (unknown.length > 0) problems.push(`${at}.targets has ${unknown.join(', ')}, which is not in targets`)
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) problems.push(`${at}.expected_seconds must be a finite positive number`)
      if (typeof id === 'string' && unitTargets !== null && typeof seconds === 'number') units.push({ id, targets: unitTargets, expected_seconds: seconds })
    }
  return { targets, units }
}

/** The FileOutputs of the last line of fetch or unit. Each problem goes into `problems`. */
const fileOutputs = (value: Record<string, unknown>, problems: string[]): FileOutputs => ({ outputs: parseOutputs(value.outputs, problems, true) })

/** Parses the last line of a unit on a scan box. The caller checks the exit code first. */
export const parseUnitOutput = (output: string): Parsed<FileOutputs> => parseLastLine('unit', output, fileOutputs)

/** The known part and the inject part of the last line of merge, each by the contract of that command. */
function mergeParts(value: Record<string, unknown>, problems: string[]): Record<'known' | 'inject', DomainJson> {
  const part = (name: 'known' | 'inject'): DomainJson => {
    const given = value[name]
    if (!isObject(given)) {
      problems.push(`${name} must be an object`)
      return { recall: null, outputs: {}, reads: null }
    }
    const own: string[] = []
    const json = domainJson(name, given, own)
    problems.push(...own.map((item) => `in ${name}, ${item}`))
    return json
  }
  return { known: part('known'), inject: part('inject') }
}

/** The analyze command of a hypothesis with its {prereg} placeholder: the config command, else the fixed entry point in analysis/<id>/. */
export function analyzeCommand(research: ResearchConfig, hypothesis: string): string {
  return research.commands.analyze ?? `python ${quote(`analysis/${hypothesis}/analyze.py`)} {prereg}`
}

/**
 * Runs one domain command of the notebook for one frozen prereg on a machine. analyze also takes the hypothesis ID. The environment is that of the checks. The
 * timeout is that of research.timeouts for the command, else that of the checks. The setup of the config runs before the first command on each machine, and a failed setup fails the command.
 */
export async function runDomainCommand(
  config: RepoConfig,
  machine: Machine,
  ...args: [name: Exclude<DomainCommand, 'analyze'>, preregPath: string] | [name: 'analyze', preregPath: string, hypothesis: string]
): Promise<DomainRun> {
  if (!config.research) throw new Error('the notebook has no research config')
  const [name, preregPath] = args
  const template = args[0] === 'analyze' ? analyzeCommand(config.research, args[2]) : config.research.commands[args[0]]
  const command = template.replaceAll('{prereg}', quote(preregPath))
  const { exit_code, output, problem } = await runOnMachine(config, machine, name, command)
  if (problem !== null) return { name, command, exit_code, output, json: null, problem }
  return { name, command, exit_code, output, ...parseLastLine(name, output, (value, problems) => domainJson(name, value, problems)) }
}

/**
 * Runs the setup one time for each machine, then the command with the check environment and the timeout of
 * research.timeouts for `name`, else that of the checks. `problem` is set when the setup or the command failed.
 */
async function runOnMachine(config: RepoConfig, machine: Machine, name: DomainCommand | 'plan' | 'fetch' | 'merge', command: string) {
  const options = commandOptions(config)
  let setup = setups.get(machine)
  if (!setup) {
    setup = setupOnce(config, (setupCommand) => machine.run(setupCommand, options))
    setups.set(machine, setup)
  }
  const failed = await setup()
  if (failed) return { exit_code: failed.exit_code, output: failed.output, problem: exitProblem(`the setup ${config.setup}`, failed.exit_code) }
  const { exit_code, output } = await machine.run(command, { ...options, timeoutMs: config.research?.timeouts?.[name] ?? options.timeoutMs })
  return { exit_code, output, problem: exit_code === 0 ? null : exitProblem(name, exit_code) }
}

/** The command of a fan-out config, or an error when the config does not fan out. */
function fanOutTemplate(config: RepoConfig, name: 'plan' | 'fetch' | 'unit' | 'merge'): string {
  const template = config.research?.commands[name]
  if (template === undefined) throw new Error(`the research config has no ${name} command`)
  return template
}

/** Runs plan for one frozen prereg on a machine, as runDomainCommand runs a domain command. Zero units is a valid plan. */
export async function runPlan(config: RepoConfig, machine: Machine, preregPath: string): Promise<PlanRun> {
  const command = fillCommand(fanOutTemplate(config, 'plan'), { prereg: quote(preregPath) })
  return lastLineRun('plan', command, await runOnMachine(config, machine, 'plan', command), planJson)
}

/** Runs fetch for one target of the plan on a machine, as runDomainCommand runs a domain command. */
export async function runFetch(config: RepoConfig, machine: Machine, preregPath: string, target: string): Promise<FetchRun> {
  const command = fillCommand(fanOutTemplate(config, 'fetch'), { prereg: quote(preregPath), target: quote(target) })
  return lastLineRun('fetch', command, await runOnMachine(config, machine, 'fetch', command), fileOutputs)
}

/** A CommandRun from a finished command and the parser of its last line. */
function lastLineRun<Name extends 'plan' | 'fetch', Json>(
  name: Name,
  command: string,
  ran: { exit_code: number | null; output: string; problem: string | null },
  parse: (value: Record<string, unknown>, problems: string[]) => Json,
): CommandRun<Name, Json> {
  const run = { name, command, exit_code: ran.exit_code, output: ran.output }
  const parsed = ran.problem === null ? parseLastLine(name, ran.output, parse) : { json: null, problem: ran.problem }
  return parsed.problem === null ? { ...run, json: parsed.json, problem: null } : { ...run, json: null, problem: parsed.problem, tail: tails([run]) }
}

/**
 * The shell command of one unit on a scan box. A scan box is a new machine, thus the setup of the config runs first in
 * the same command. The caller gives the timeout of the unit.
 */
export function unitCommand(config: RepoConfig, preregPath: string, unit: string): string {
  const command = fillCommand(fanOutTemplate(config, 'unit'), { prereg: quote(preregPath), unit: quote(unit) })
  return config.setup ? `(${config.setup}\n) && ${command}` : command
}

/**
 * Runs merge on a machine, with {units} as the path of the units directory (UnitsManifest). Its last line has a known
 * part and an inject part, each by the contract of that command. The result is a known run and an inject run of the
 * same command, exit code and output, for calibrationVerdict. When merge fails, both runs fail with its problem.
 */
export async function runMerge(config: RepoConfig, machine: Machine, preregPath: string, unitsDir: string): Promise<{ known: DomainRun; inject: DomainRun }> {
  const command = fillCommand(fanOutTemplate(config, 'merge'), { prereg: quote(preregPath), units: quote(unitsDir) })
  const { exit_code, output, problem } = await runOnMachine(config, machine, 'merge', command)
  const parsed = problem === null ? parseLastLine('merge', output, mergeParts) : { json: null, problem }
  const run = (name: 'known' | 'inject'): DomainRun =>
    parsed.problem === null ? { name, command, exit_code, output, json: parsed.json[name], problem: null } : { name, command, exit_code, output, json: null, problem: parsed.problem }
  return { known: run('known'), inject: run('inject') }
}

/** The tails of the runs, about failureTailChars together, each under a line that names its command. */
function tails(runs: { name: string; command: string; exit_code: number | null; output: string }[]): string {
  const chars = Math.floor(failureTailChars / Math.max(runs.length, 1))
  return runs.map((run) => `--- ${run.name}: ${run.command} (exit code ${run.exit_code})\n${run.output.slice(-chars)}`).join('\n')
}

/**
 * The verdict of one calibration round (decision 2): it passes only when known and inject give valid JSON and the known
 * recall is the threshold or more. The outputs are those of known and inject together.
 */
export function calibrationVerdict(known: DomainRun, inject: DomainRun, threshold: number): Calibration {
  const recall = known.json?.recall ?? null
  const outputs: DomainOutputs = { ...known.json?.outputs }
  const conflicts: string[] = []
  for (const [path, hash] of Object.entries(inject.json?.outputs ?? {})) {
    if (outputs[path] !== undefined && outputs[path] !== hash) conflicts.push(path)
    outputs[path] = hash
  }
  const failed = [known, inject].filter((run) => run.problem !== null)
  if (failed.length > 0) return { pass: false, recall, threshold, outputs, reason: failed.map((run) => run.problem).join('\n'), tail: tails(failed) }
  // With no outputs, the reproduction compares no hash and always passes.
  if (Object.keys(outputs).length === 0)
    return { pass: false, recall, threshold, outputs, reason: 'known and inject give no outputs, but the reproduction needs at least one path to SHA-256 hex', tail: tails([known, inject]) }
  if (conflicts.length > 0)
    return { pass: false, recall, threshold, outputs, reason: `known and inject give different hashes for ${conflicts.join(', ')}`, tail: tails([known, inject]) }
  if (recall === null || recall < threshold)
    return { pass: false, recall, threshold, outputs, reason: `the known recall ${recall} is below the threshold ${threshold}`, tail: tails([known]) }
  return { pass: true, recall, threshold, outputs }
}

/**
 * The verdict of one analysis: it passes when analyze gives valid JSON with at least one output, and no output path is a
 * calibration output with a different hash.
 */
export function analysisVerdict(run: DomainRun, calibrationOutputs: DomainOutputs): AnalysisVerdict {
  if (run.problem !== null) return { pass: false, outputs: {}, reason: run.problem, tail: tails([run]) }
  const outputs = run.json.outputs
  if (Object.keys(outputs).length === 0) return { pass: false, outputs, reason: 'analyze gives no output', tail: tails([run]) }
  const conflicts = Object.entries(outputs)
    .filter(([path, hash]) => calibrationOutputs[path] !== undefined && calibrationOutputs[path] !== hash)
    .map(([path]) => path)
  if (conflicts.length > 0)
    return { pass: false, outputs, reason: `analyze and the calibration give different hashes for ${conflicts.join(', ')}`, tail: tails([run]) }
  return { pass: true, outputs }
}

/**
 * Tells if a calibration must run again after a change. `changed` holds changed file paths, or directories that end
 * with /. It is true when known or inject gives no reads, or when a reads prefix matches a changed path: the path starts
 * with the prefix, or the prefix is in a changed directory.
 */
export function needsRecalibration(knownReads: string[] | null, injectReads: string[] | null, changed: string[]): boolean {
  if (knownReads === null || injectReads === null) return true
  return [...knownReads, ...injectReads].some((prefix) =>
    changed.some((path) => path.startsWith(prefix) || (path.endsWith('/') && prefix.startsWith(path))),
  )
}

/** Compares the reproduce outputs with the outputs of the final calibration. Paths that only reproduce gives do not count. */
export function compareReproduction(expected: DomainOutputs, reproduce: DomainRun): Reproduction {
  if (reproduce.problem !== null) return { pass: false, mismatches: [], missing: [], reason: reproduce.problem, tail: tails([reproduce]) }
  const actual = reproduce.json.outputs
  const mismatches: HashMismatch[] = []
  const missing: string[] = []
  for (const [path, hash] of Object.entries(expected)) {
    const found = actual[path]
    if (found === undefined) missing.push(path)
    else if (found !== hash) mismatches.push({ path, expected: hash, actual: found })
  }
  if (mismatches.length === 0 && missing.length === 0) return { pass: true, mismatches, missing }
  const reason = [
    ...mismatches.map(({ path, expected: want, actual: got }) => `${path}: expected ${want}, reproduce gave ${got}`),
    ...missing.map((path) => `${path}: reproduce gave no hash`),
  ].join('\n')
  return { pass: false, mismatches, missing, reason, tail: tails([reproduce]) }
}

/** The threshold of a frozen prereg: its line "Known recall: <n>" that freezePrereg writes. */
export function preregThreshold(markdown: string): number {
  const match = /^Known recall: (.*)$/m.exec(markdown)
  const value = match ? Number(match[1]!.trim()) : Number.NaN
  if (match === null || match[1]!.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('the frozen prereg has no line "Known recall: <n>" with a number from 0 to 1')
  return value
}
