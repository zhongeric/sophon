import { checkEnv, defaultTimeoutMs, type Machine, type RepoConfig } from './checks.ts'
import { hostSecrets } from './secrets.ts'

/** The domain commands of stages 6 and 11 (section 6.3 of docs/specs/research-workflow.md). */
export type DomainCommand = 'known' | 'inject' | 'reproduce'

/** The outputs of a domain command: path to the lowercase SHA-256 hex of its bytes. */
export type DomainOutputs = Record<string, string>

/** The last line of a domain command. Only known gives a recall. */
export type DomainJson = { recall: number | null; outputs: DomainOutputs }

/** One run of a domain command. `problem` is set exactly when the run failed or its last line is not valid. */
export type DomainRun = { name: DomainCommand; command: string; exit_code: number | null; output: string } & (
  | { json: DomainJson; problem: null }
  | { json: null; problem: string }
)

export type Calibration = { recall: number | null; threshold: number; outputs: DomainOutputs } & (
  | { pass: true }
  | { pass: false; reason: string; tail: string }
)

export type HashMismatch = { path: string; expected: string; actual: string }

export type Reproduction = { mismatches: HashMismatch[]; missing: string[] } & ({ pass: true } | { pass: false; reason: string; tail: string })

/** The output tail that a failure gives to the builder and to the report. */
export const failureTailChars = 4_000

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const sha256Hex = /^[0-9a-f]{64}$/

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The setup result of each machine. A failed setup runs again before the next command, as in commandChecker. */
const setups = new WeakMap<Machine, Promise<{ exit_code: number | null; output: string }>>()

function setup(config: RepoConfig, machine: Machine, env: string[], timeoutMs: number): Promise<{ exit_code: number | null; output: string }> | null {
  if (!config.setup) return null
  const known = setups.get(machine)
  if (known) return known
  const started = machine.run(config.setup, { env, timeoutMs })
  setups.set(machine, started)
  void started.then(
    (result) => result.exit_code === 0 || setups.delete(machine),
    () => setups.delete(machine),
  )
  return started
}

const exitProblem = (what: string, exitCode: number | null) =>
  exitCode === null ? `${what} did not finish: it timed out or the host stopped it` : `${what} exited with code ${exitCode}`

/** Parses the last non-empty line of the output by the contract of the command, or gives the problem. */
export function parseDomainOutput(name: DomainCommand, output: string): { json: DomainJson; problem: null } | { json: null; problem: string } {
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
  const outputs: DomainOutputs = {}
  if (!isObject(value.outputs)) problems.push('outputs must be an object of path to SHA-256 hex')
  else
    for (const [path, hash] of Object.entries(value.outputs)) {
      if (path.trim() === '') problems.push('an output path is empty')
      else if (typeof hash !== 'string' || !sha256Hex.test(hash.toLowerCase())) problems.push(`the hash of ${path} is not SHA-256 hex`)
      else outputs[path] = hash.toLowerCase()
    }
  if (problems.length > 0) return { json: null, problem: `the last line of ${name}: ${problems.join(', ')}` }
  return { json: { recall, outputs }, problem: null }
}

/**
 * Runs one domain command of the notebook for one frozen prereg on a machine. The environment and the timeout are those
 * of the checks. The setup of the config runs before the first command on each machine, and a failed setup fails the command.
 */
export async function runDomainCommand(config: RepoConfig, machine: Machine, name: DomainCommand, preregPath: string): Promise<DomainRun> {
  if (!config.research) throw new Error('the notebook has no research config')
  const command = config.research.commands[name].replaceAll('{prereg}', quote(preregPath))
  const env = [...checkEnv, ...(config.env ?? [])].filter((item) => !hostSecrets.includes(item))
  const timeoutMs = config.timeout_ms ?? defaultTimeoutMs
  const prepared = await setup(config, machine, env, timeoutMs)
  if (prepared && prepared.exit_code !== 0)
    return { name, command, exit_code: prepared.exit_code, output: prepared.output, json: null, problem: exitProblem(`the setup ${config.setup}`, prepared.exit_code) }
  const { exit_code, output } = await machine.run(command, { env, timeoutMs })
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
  if (conflicts.length > 0)
    return { pass: false, recall, threshold, outputs, reason: `known and inject give different hashes for ${conflicts.join(', ')}`, tail: tails([known, inject]) }
  if (recall === null || recall < threshold)
    return { pass: false, recall, threshold, outputs, reason: `the known recall ${recall} is below the threshold ${threshold}`, tail: tails([known]) }
  return { pass: true, recall, threshold, outputs }
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
