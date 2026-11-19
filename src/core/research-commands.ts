import { commandOptions, quote, setupOnce, type Machine, type RepoConfig } from './checks.ts'
import type { ResearchConfig } from './research.ts'

/** The domain commands of stages 6 and 11 (section 6.3 of docs/specs/research-workflow.md). */
export type DomainCommand = 'known' | 'inject' | 'reproduce' | 'analyze'

/** The outputs of a domain command: path to the lowercase SHA-256 hex of its bytes. */
export type DomainOutputs = Record<string, string>

/**
 * The last line of a domain command. Only known gives a recall. Only known and inject give reads: the path prefixes that
 * they read, with no leading slash. reads is null when the command does not give it.
 */
export type DomainJson = { recall: number | null; outputs: DomainOutputs; reads: string[] | null }

/** One run of a domain command. `problem` is set exactly when the run failed or its last line is not valid. */
export type DomainRun = { name: DomainCommand; command: string; exit_code: number | null; output: string } & (
  | { json: DomainJson; problem: null }
  | { json: null; problem: string }
)

export type Calibration = { recall: number | null; threshold: number; outputs: DomainOutputs } & (
  | { pass: true }
  | { pass: false; reason: string; tail: string }
)

export type Analysis = { outputs: DomainOutputs } & ({ pass: true } | { pass: false; reason: string; tail: string })

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

/** Parses the last non-empty line of the output by the contract of the command, or gives the problem. */
function parseDomainOutput(name: DomainCommand, output: string): { json: DomainJson; problem: null } | { json: null; problem: string } {
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
  let recall: number | null = null
  if (name === 'known') {
    if (typeof value.recall === 'number' && Number.isFinite(value.recall) && value.recall >= 0 && value.recall <= 1) recall = value.recall
    else problems.push('recall must be a number from 0 to 1')
  }
  let reads: string[] | null = null
  if ((name === 'known' || name === 'inject') && value.reads !== undefined) {
    const items = Array.isArray(value.reads) ? value.reads.map((item: unknown) => (typeof item === 'string' ? item.trim().replace(/^\/+/, '') : '')) : []
    if (!Array.isArray(value.reads) || items.includes('')) problems.push('reads must be a list of non-empty path prefixes')
    else reads = items
  }
  const outputs: DomainOutputs = {}
  if (!isObject(value.outputs)) problems.push('outputs must be an object of path to SHA-256 hex')
  else
    for (const [path, hash] of Object.entries(value.outputs)) {
      if (path.trim() === '') problems.push('an output path is empty')
      else if (typeof hash !== 'string' || !sha256Hex.test(hash.toLowerCase())) problems.push(`the hash of ${path} is not SHA-256 hex`)
      else outputs[path] = hash.toLowerCase()
    }
  if (problems.length > 0) return { json: null, problem: `the last line of ${name}: ${problems.join(', ')}` }
  return { json: { recall, outputs, reads }, problem: null }
}

/** The analyze command of a hypothesis with its {prereg} placeholder: the config command, else the fixed entry point in analysis/<id>/. */
export function analyzeCommand(research: ResearchConfig, hypothesis: string): string {
  return research.commands.analyze ?? `python ${quote(`analysis/${hypothesis}/analyze.py`)} {prereg}`
}

/**
 * Runs one domain command of the notebook for one frozen prereg on a machine. analyze needs the hypothesis ID. The environment is that of the checks. The
 * timeout is that of research.timeouts for the command, else that of the checks. The setup of the config runs before the first command on each machine, and a failed setup fails the command.
 */
export async function runDomainCommand(config: RepoConfig, machine: Machine, name: DomainCommand, preregPath: string, hypothesis?: string): Promise<DomainRun> {
  if (!config.research) throw new Error('the notebook has no research config')
  let template: string
  if (name !== 'analyze') template = config.research.commands[name]
  else if (hypothesis !== undefined) template = analyzeCommand(config.research, hypothesis)
  else throw new Error('the analyze command needs the hypothesis ID')
  const command = template.replaceAll('{prereg}', quote(preregPath))
  const options = commandOptions(config)
  let setup = setups.get(machine)
  if (!setup) {
    setup = setupOnce(config, (setupCommand) => machine.run(setupCommand, options))
    setups.set(machine, setup)
  }
  const failed = await setup()
  if (failed) return { name, command, exit_code: failed.exit_code, output: failed.output, json: null, problem: exitProblem(`the setup ${config.setup}`, failed.exit_code) }
  const { exit_code, output } = await machine.run(command, { ...options, timeoutMs: config.research.timeouts?.[name] ?? options.timeoutMs })
  if (exit_code !== 0) return { name, command, exit_code, output, json: null, problem: exitProblem(name, exit_code) }
  return { name, command, exit_code, output, ...parseDomainOutput(name, output) }
}

/** The tails of the runs, about failureTailChars together, each under a line that names its command. */
function tails(runs: DomainRun[]): string {
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
export function analysisVerdict(run: DomainRun, calibrationOutputs: DomainOutputs): Analysis {
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
