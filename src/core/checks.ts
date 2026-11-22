import type { Contracts } from 'nanocode-ts'
import type { Checker, Repo } from './platform.ts'
import { profileDefaults, type RootFiles } from './profiles.ts'
import { parseResearchConfig, type ResearchConfig } from './research.ts'
import { hostSecrets } from './secrets.ts'
import { StopError } from './stop.ts'

export type Check = string | { command: string; files?: string }

export type MergeMethod = 'squash' | 'merge' | 'rebase'
const mergeMethods: readonly unknown[] = ['squash', 'merge', 'rebase'] satisfies MergeMethod[]

/** The target repository's checks and rails: the profile defaults, and .agent-factory.json. Agents cannot change it. */
export type RepoConfig = {
  stack: string
  checks: Record<string, Check>
  /** Null in .agent-factory.json turns off the tests that a profile gives. */
  tests?: { pattern: string; command: string } | null
  /** The commands of the repository CI, in the form of `checks`. Each submit gate and the final checks run them (D15). No profile gives them. */
  ci?: Record<string, Check> | null
  /** A command that the host runs in each new worktree before its first check, for example npm ci. */
  setup?: string
  /** Reference material mounted read-only at /guides/<name>: name to file or directory path, on hosts with a disk. */
  guides?: Record<string, string>
  protect?: string[]
  /** Extra environment variables that the checks need, for example ETH_RPC_URL. Others are not passed. */
  env?: string[]
  /** GitHub logins whose PR replies answer questions. */
  answerers?: string[]
  timeout_ms?: number
  /** The standing permission for the host to merge a ready development PR, with this method. Without it, the host does not merge. */
  merge?: MergeMethod
  /** The standing answer to every question of a run: the host takes the recommendation and asks nobody (D11). */
  questions?: 'recommended'
  /** The domain of a research notebook: section 6.3 of docs/specs/research-workflow.md. */
  research?: ResearchConfig
}

export const repoConfigFile = '.agent-factory.json'

const isCheck = (value: unknown): value is Check =>
  typeof value === 'string' ||
  (typeof value === 'object' && value !== null && !Array.isArray(value) && 'command' in value && typeof value.command === 'string' &&
    (!('files' in value) || value.files === undefined || typeof value.files === 'string'))

/** Parses .agent-factory.json. Each field that it sets replaces the profile default of that field. */
export function parseRepoConfig(text: string, source: string): Partial<RepoConfig> {
  const config = JSON.parse(text) as Partial<RepoConfig>
  if (config.checks !== undefined && (typeof config.checks !== 'object' || config.checks === null))
    throw new StopError(`${source}: checks must be an object of named commands`)
  if (config.ci !== undefined && config.ci !== null && (typeof config.ci !== 'object' || Array.isArray(config.ci)))
    throw new StopError(`${source}: ci must be an object of named commands`)
  for (const [name, check] of Object.entries(config.ci ?? {})) if (!isCheck(check)) throw new StopError(`${source}: ci.${name} must be a command string or { command, files? } with strings`)
  if (config.tests && !/\{tests?\}/.test(config.tests.command)) throw new StopError(`${source}: tests.command needs {test} or {tests}`)
  if ('merge' in config && !mergeMethods.includes(config.merge)) throw new StopError(`${source}: merge must be "squash", "merge" or "rebase"`)
  if ('questions' in config && config.questions !== 'recommended') throw new StopError(`${source}: questions must be "recommended"`)
  if (config.research !== undefined) config.research = parseResearchConfig(config.research, source)
  return config
}

/**
 * The config of a repository: the defaults of its profiles, and in place of each one, the field that
 * .agent-factory.json sets, also when the file sets null or an empty value. The stack is "unknown" when nothing names it.
 */
export function resolveRepoConfig(defaults: Partial<RepoConfig>, file: Partial<RepoConfig> | null): RepoConfig {
  const config = { ...defaults, ...file }
  return { ...config, stack: config.stack || 'unknown', checks: config.checks ?? {} }
}

/** The config of the repository whose root is `root`: its profile defaults and its .agent-factory.json, if it has one. */
export async function readRepoConfig(root: RootFiles, source: string): Promise<RepoConfig> {
  const text = await root.read(repoConfigFile)
  return resolveRepoConfig(await profileDefaults(root), text === null ? null : parseRepoConfig(text, `${repoConfigFile} ${source}`))
}

export const hasCi = (config: RepoConfig): boolean => Object.keys(config.ci ?? {}).length > 0

/** A host that runs the checks on a machine needs at least one check. */
export function requireChecks(config: RepoConfig, repository: string): RepoConfig {
  if (Object.keys(config.checks).length === 0)
    throw new StopError(`${repository} has no checks: no profile gives default checks for its stack. Add ${repoConfigFile} with its checks (see README).`)
  return config
}

/**
 * An entry matches an exact path or a directory prefix, and only a directory prefix when it ends with `/`. In an entry
 * with `*`, each `*` matches characters in one path segment.
 */
function matchesProtectEntry(entry: string, relative: string): boolean {
  const source = entry.replace(/\/$/, '').split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  return new RegExp(entry.endsWith('/') ? `^${source}/` : `^${source}(/|$)`).test(relative)
}

/** The entries that no change may write: the config file first, then the protect entries of the config. */
export function protectedEntries(config: RepoConfig): string[] {
  return [repoConfigFile, ...(config.protect ?? [])]
}

export function isProtected(config: RepoConfig, path: string): boolean {
  const relative = path.replace(/^\/+/, '')
  return protectedEntries(config).some((entry) => matchesProtectEntry(entry, relative))
}

export type CheckResult = {
  name: string
  command: string
  status: 'pass' | 'fail' | 'skipped'
  exit_code: number | null
  output: string
}

/** Runs one shell command in the run's tree on a real machine. */
export type Machine = {
  run(command: string, options: { env: string[]; timeoutMs: number }): Promise<{ exit_code: number | null; output: string }>
}

/** The environment of check commands: these variables, plus the config's `env` list, never the host's secrets. */
const checkEnv = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ']
const defaultTimeoutMs = 30 * 60_000
const toolOutputTailChars = 8_000

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The options of each command that the host runs from the config: the check environment and the config timeout. */
export function commandOptions(config: RepoConfig): { env: string[]; timeoutMs: number } {
  return { env: [...checkEnv, ...(config.env ?? [])].filter((name) => !hostSecrets.includes(name)), timeoutMs: config.timeout_ms ?? defaultTimeoutMs }
}

/**
 * A function that runs the setup of the config one time. A failed setup runs again at the next call.
 * The function gives the failed result, or null when the setup passed or the config has no setup.
 */
export function setupOnce<T extends { exit_code: number | null }>(config: RepoConfig, run: (command: string) => Promise<T>): () => Promise<T | null> {
  let ready: Promise<T | null> | null = null
  return async () => {
    if (!config.setup) return null
    ready ??= run(config.setup).then((result) => (result.exit_code === 0 ? null : result))
    try {
      const failed = await ready
      if (failed) ready = null
      return failed
    } catch (error) {
      ready = null
      throw error
    }
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The parts of a repository that the checks read. */
type Tree = Pick<Repo, 'tree' | 'committedFiles'>

async function exists(repo: Tree, path: string): Promise<boolean> {
  return (await repo.tree.stat(`/${path}`)) !== null
}

/** The last path segment without its extension: src/core/agent.ts gives agent. */
export const baseName = (path: string) => path.split('/').at(-1)!.replace(/\.[^.]*$/, '')

/** The last segment of a Python module. The leading dots of a relative import do not count. */
const moduleName = (module: string) => module.replace(/^\.+/, '').split('.').at(-1)!

// A `from '...'` part on any line covers import and export lines over more lines, and the Solidity import {X} from.
const fromPath = /\bfrom\s+(['"])([^'"\n]+)\1/g
const importPath = /\bimport\s+(['"])([^'"\n]+)\1/g
const callPath = /\b(?:require|import)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
// The full line must match, so that a TypeScript `import x from '...'` does not give x.
const pythonImport = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)[ \t]*(?:#.*)?$/gm
const pythonFrom = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm

/** The names of the direct import lines of a file: the base name of each import path, and the Python module and imported names. */
function importNames(content: string): Set<string> {
  const names = new Set<string>()
  for (const regex of [fromPath, importPath, callPath]) for (const match of content.matchAll(regex)) names.add(baseName(match[2]!))
  for (const match of content.matchAll(pythonImport))
    for (const part of match[1]!.split(',')) names.add(moduleName(part.trim().split(/\s+/)[0]!))
  for (const match of content.matchAll(pythonFrom)) {
    names.add(moduleName(match[1]!))
    for (const part of match[2]!.replace(/[()\\]/g, ' ').split(',')) {
      const name = part.trim().split(/\s+/)[0]!
      if (/^\w+$/.test(name)) names.add(name)
    }
  }
  names.delete('')
  return names
}

/**
 * The targeted tests: the changed test files, and the test files whose direct import lines name the base name of a
 * changed source file. When no test file imports a changed file, the test files that have its base name as a word
 * are also targeted. Thus a file that the tests reach through a process, or a file that is not code, keeps its tests.
 * Only committed test files that exist, in the order of committedFiles.
 */
export async function targetedTests(repo: Tree, config: RepoConfig, changed: string[]): Promise<string[]> {
  if (!config.tests) return []
  const pattern = new RegExp(config.tests.pattern)
  const files: { path: string; content: string; imports: Set<string> }[] = []
  for (const path of new Set((await repo.committedFiles()).filter((path) => pattern.test(path)))) {
    if (!(await exists(repo, path))) continue
    const content = text(await repo.tree.read(`/${path}`))
    files.push({ path, content, imports: importNames(content) })
  }
  const sources = [...new Set(changed.filter((path) => !pattern.test(path)).map(baseName))]
  const imported = sources.filter((name) => files.some((file) => file.imports.has(name)))
  const words = sources
    .filter((name) => !imported.includes(name))
    .map((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`))
  return files
    .filter((file) => changed.includes(file.path) || imported.some((name) => file.imports.has(name)) || words.some((word) => word.test(file.content)))
    .map((file) => file.path)
}

/** Checks that run the configured commands on a machine. Commands come from the config only. */
export function commandChecker(repo: Tree, config: RepoConfig, machine: Machine): Checker {
  const options = commandOptions(config)
  const run = async (name: string, command: string): Promise<CheckResult> => {
    const result = await machine.run(command, options)
    return { name, command, status: result.exit_code === 0 ? 'pass' : 'fail', ...result }
  }
  // The setup runs one time for each checker, which is one worktree.
  const setup = setupOnce(config, (command) => run('setup', command))
  const runTests = async (tests: string[]): Promise<CheckResult[]> => {
    if (!config.tests || tests.length === 0) return []
    const failed = await setup()
    if (failed) return [failed]
    const command = config.tests.command
    if (command.includes('{tests}')) return [await run('tests', command.replace('{tests}', tests.map(quote).join(' ')))]
    const results: CheckResult[] = []
    for (const test of tests) results.push(await run(`test ${test}`, command.replace('{test}', quote(test))))
    return results
  }
  // The named commands of `checks` or of `ci`, after the setup passed. `prefix` tells a ci result from a check of the same name.
  const runNamed = async (entries: Record<string, Check>, changed: string[], prefix: string): Promise<CheckResult[]> => {
    const results: CheckResult[] = []
    for (const [key, check] of Object.entries(entries)) {
      const name = `${prefix}${key}`
      const { command, files } = typeof check === 'string' ? { command: check, files: undefined } : check
      if (!command.includes('{files}')) {
        results.push(await run(name, command))
        continue
      }
      const matching: string[] = []
      for (const path of changed) if ((files ? new RegExp(files).test(path) : true) && (await exists(repo, path))) matching.push(path)
      if (matching.length === 0) results.push({ name, command, status: 'skipped', exit_code: null, output: 'no changed files match' })
      else results.push(await run(name, command.replace('{files}', matching.map(quote).join(' '))))
    }
    return results
  }
  const ci = async (changed: string[]): Promise<CheckResult[]> => {
    const failed = await setup()
    if (failed) return [failed]
    return runNamed(config.ci ?? {}, changed, 'ci ')
  }
  const checks: Checker['checks'] = async (changed, options = {}) => {
    const failed = await setup()
    if (failed) return [failed]
    const results = await runNamed(config.checks, changed, '')
    if (options.tests === false) return results
    const tests = await targetedTests(repo, config, changed)
    if (tests.length === 0) results.push({ name: 'tests', command: config.tests?.command ?? '', status: 'skipped', exit_code: null, output: 'no targeted tests' })
    else results.push(...(await runTests(tests)))
    // On Node, the final checks also run the ci commands, after the tests (D15).
    if (hasCi(config)) results.push(...(await ci(changed)))
    return results
  }
  return {
    checks,
    tests: config.tests ? runTests : null,
    agentChecks: (changed) => checks(changed, { tests: false }),
    ...(hasCi(config) ? { ci } : {}),
  }
}

export const runTestsTool: Contracts.HostTool = {
  name: 'run_tests',
  description:
    'Run specific test files of /repo with the project test command, on the real machine. Give only the test files for the changed code. ' +
    'The host refuses files that are not committed test files, so a new test file runs in the checks after the host commits it. ' +
    'The host runs one test command at a time. Returns the exit code and the end of the output of each run.',
  parameters: {
    type: 'object',
    properties: { tests: { type: 'array', items: { type: 'string' }, description: 'Test file paths relative to /repo' } },
    required: ['tests'],
    additionalProperties: false,
  },
}

/** The run_tests tool: only committed files that match the test pattern. */
export async function callRunTests(repo: Pick<Repo, 'committedFiles'>, config: RepoConfig, run: NonNullable<Checker['tests']>, input: unknown): Promise<unknown> {
  if (!config.tests) throw new Error('this repository has no test command')
  const requested = ((input as { tests?: unknown }).tests ?? []) as unknown[]
  const pattern = new RegExp(config.tests.pattern)
  const committed = new Set(await repo.committedFiles())
  const tests = requested.map((test) => String(test).replace(/^\/repo\//, ''))
  const refused = tests.filter((test) => !pattern.test(test) || !committed.has(test))
  if (tests.length === 0 || refused.length > 0) throw new Error(`not committed test files: ${refused.join(', ') || '(none given)'}`)
  return (await run(tests)).map(({ name, status, exit_code, output }) => ({ name, status, exit_code, output: output.slice(-toolOutputTailChars) }))
}

const checkOutputTailChars = 4_000

/** The run_checks tool of an editing agent. `files` names the files that it checks, and `more` ends the description. */
export const runChecksTool = (files: string, more = ''): Contracts.HostTool => ({
  name: 'run_checks',
  description: `Run the repository's configured checks (for example typecheck, lint, build) on ${files}, on the real machine. It runs no tests. Returns each status and the end of its output.${more}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
})

/** The result of run_checks for an agent: each status and the end of its output. */
export const checkTails = (results: CheckResult[]) =>
  results.map(({ name, status, exit_code, output }) => ({ name, status, exit_code, output: output.slice(-checkOutputTailChars) }))

/** A failed check with the end of its output, cut as the refusal of a submit cuts it. */
export type FailedCheck = { name: string; command: string; output: string }

export const failedChecks = (results: CheckResult[]): FailedCheck[] =>
  results.filter((result) => result.status === 'fail').map(({ name, command, output }) => ({ name, command, output: output.slice(-checkOutputTailChars) }))

/** The failed checks or tests in the refusal of a submit: the name, the exit code and the end of the output of each. */
export const failureText = (failed: CheckResult[]): string[] =>
  failed.map(({ name, exit_code, output }) => `--- ${name} (exit code ${exit_code ?? 'none'}) ---\n${output.slice(-checkOutputTailChars)}`)
