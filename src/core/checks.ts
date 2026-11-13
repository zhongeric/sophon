import type { Contracts } from 'nanocode-ts'
import type { Checker, Repo } from './platform.ts'
import { hostSecrets } from './secrets.ts'
import { StopError } from './stop.ts'

export type Check = string | { command: string; files?: string }

/** The target repository's checks and rails, from .agent-factory.json. Agents cannot change it. */
export type RepoConfig = {
  stack: string
  checks: Record<string, Check>
  tests?: { pattern: string; command: string }
  /** Reference material mounted read-only at /guides/<name>: name to file or directory path, on hosts with a disk. */
  guides?: Record<string, string>
  protect?: string[]
  /** Extra environment variables that the checks need, for example ETH_RPC_URL. Others are not passed. */
  env?: string[]
  /** GitHub logins whose PR replies answer questions. */
  answerers?: string[]
  timeout_ms?: number
}

export const repoConfigFile = '.agent-factory.json'

export function parseRepoConfig(text: string, source: string): RepoConfig {
  const config = JSON.parse(text) as RepoConfig
  if (!config.stack) throw new StopError(`${source} needs a stack, for example "TypeScript" or "Solidity+Foundry"`)
  if (!config.checks || Object.keys(config.checks).length === 0) throw new StopError(`${source} needs at least one check`)
  if (config.tests && !/\{tests?\}/.test(config.tests.command)) throw new StopError(`${source}: tests.command needs {test} or {tests}`)
  return config
}

export function isProtected(config: RepoConfig, path: string): boolean {
  const relative = path.replace(/^\/+/, '')
  return [repoConfigFile, ...(config.protect ?? [])].some((entry) => relative === entry || relative.startsWith(`${entry.replace(/\/$/, '')}/`))
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

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

async function exists(repo: Repo, path: string): Promise<boolean> {
  return (await repo.tree.stat(`/${path}`)) !== null
}

/** The test files that the change touches, and the test files that mention a changed source file. */
export async function targetedTests(repo: Repo, config: RepoConfig, changed: string[]): Promise<string[]> {
  if (!config.tests) return []
  const pattern = new RegExp(config.tests.pattern)
  const tests = (await repo.committedFiles()).filter((path) => pattern.test(path))
  const sources = changed.filter((path) => !pattern.test(path)).map((path) => path.split('/').at(-1)!.replace(/\.[^.]*$/, ''))
  const words = sources.map((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`))
  const targeted: string[] = []
  for (const path of tests) {
    if (changed.includes(path)) targeted.push(path)
    else if (await exists(repo, path)) {
      const content = text(await repo.tree.read(`/${path}`))
      if (words.some((word) => word.test(content))) targeted.push(path)
    }
  }
  return targeted
}

/** Checks that run the configured commands on a machine. Commands come from the config only. */
export function commandChecker(repo: Repo, config: RepoConfig, machine: Machine): Checker {
  const env = [...checkEnv, ...(config.env ?? [])].filter((name) => !hostSecrets.includes(name))
  const run = async (name: string, command: string): Promise<CheckResult> => {
    const result = await machine.run(command, { env, timeoutMs: config.timeout_ms ?? defaultTimeoutMs })
    return { name, command, status: result.exit_code === 0 ? 'pass' : 'fail', ...result }
  }
  const runTests = async (tests: string[]): Promise<CheckResult[]> => {
    if (!config.tests || tests.length === 0) return []
    const command = config.tests.command
    if (command.includes('{tests}')) return [await run('tests', command.replace('{tests}', tests.map(quote).join(' ')))]
    const results: CheckResult[] = []
    for (const test of tests) results.push(await run(`test ${test}`, command.replace('{test}', quote(test))))
    return results
  }
  return {
    async checks(changed) {
      const results: CheckResult[] = []
      for (const [name, check] of Object.entries(config.checks)) {
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
      const tests = await targetedTests(repo, config, changed)
      if (tests.length === 0) results.push({ name: 'tests', command: config.tests?.command ?? '', status: 'skipped', exit_code: null, output: 'no targeted tests' })
      else results.push(...(await runTests(tests)))
      return results
    },
    tests: config.tests ? runTests : null,
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
export async function callRunTests(repo: Repo, config: RepoConfig, run: NonNullable<Checker['tests']>, input: unknown): Promise<unknown> {
  if (!config.tests) throw new Error('this repository has no test command')
  const requested = ((input as { tests?: unknown }).tests ?? []) as unknown[]
  const pattern = new RegExp(config.tests.pattern)
  const committed = new Set(await repo.committedFiles())
  const tests = requested.map((test) => String(test).replace(/^\/repo\//, ''))
  const refused = tests.filter((test) => !pattern.test(test) || !committed.has(test))
  if (tests.length === 0 || refused.length > 0) throw new Error(`not committed test files: ${refused.join(', ') || '(none given)'}`)
  return (await run(tests)).map(({ name, status, exit_code, output }) => ({ name, status, exit_code, output: output.slice(-toolOutputTailChars) }))
}
