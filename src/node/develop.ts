import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { repoConfigFile } from '../core/checks.ts'
import { parseParallel } from '../core/plan.ts'
import type { Credentials } from '../core/providers.ts'
import { commentChannel, PausedError } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { allowedModelsFrom, mergeModels, type LoopModels } from '../core/workflows/code-review-loop.ts'
import { defaultDevelopModels, develop, developProviders, type DevelopInput, type DevelopModels } from '../core/workflows/develop.ts'
import { fileChannel, gh, ghComments, terminalChannel } from './channels.ts'
import { credential } from './credentials.ts'
import { git } from './git.ts'
import { ghPullRequests } from './github.ts'
import { fileLedger } from './ledger.ts'
import { loadRepoConfig, nodeDevelop } from './platform.ts'

const defaultWaitMinutes = 60
const pollMs = 30_000
const ciStartMs = 10 * 60_000
const pausedExitCode = 3

const usage = `Usage: npm run develop -- --ask <text> [options]

Develops an ask into a ready PR: intake and your confirmation, a spec for a larger change, a plan, builders
for its tasks, a draft PR, CI with two fix rounds, the code review loop, and CI again. The PR becomes ready
only when every criterion holds. You merge.

Options:
  --repo <path>          Repository (default: current directory). It needs ${repoConfigFile} and an origin on GitHub.
  --ask <text>           The ask, verbatim
  --ask-file <path>      Read the ask from a file
  --base <branch>        The branch to build on and to open the PR against (default: main)
  --run <id>             Resume a run; the other options come from its ledger
  --runs-dir <path>      Where runs live (default: <agent-factory>/runs)
  --hotfix               A small hotfix: take every recommendation without asking
  --full                 The full review loop, also for a docs or tests only change
  --parallel <n>         At most n builders at the same time (default 3)
  --models <path>        JSON that overrides models: { "develop": { "builder": ... }, "review": { "step1": ... } }
  --claude-plan          Sign Claude requests with the nc Claude login instead of ANTHROPIC_API_KEY
  --wait <minutes>       How long to wait for answers or CI before the run pauses (default 60)

Questions go to the terminal when it is interactive. Otherwise the intake and spec questions go to a file in
the run directory, and the review questions go to the PR. A paused run exits with status 3; resume it with
--run <id>.

Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, ALLOWED_MODELS (model IDs, comma-separated). The gh CLI must be logged in.`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      ask: { type: 'string' },
      'ask-file': { type: 'string' },
      base: { type: 'string' },
      'claude-plan': { type: 'boolean' },
      full: { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      hotfix: { type: 'boolean' },
      models: { type: 'string' },
      parallel: { type: 'string' },
      repo: { type: 'string' },
      run: { type: 'string' },
      'runs-dir': { type: 'string' },
      wait: { type: 'string' },
    },
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const runsDir = resolve(values['runs-dir'] ?? fileURLToPath(new URL('../../runs/', import.meta.url)))
  const { input, repo } = values.run ? resumeInput(runsDir, values.run) : await newInput(values)

  const credentials: Credentials = {}
  for (const provider of developProviders(input.models)) credentials[provider] = credential(provider, { claudePlan: values['claude-plan'] })
  const waitMs = Number(values.wait ?? defaultWaitMinutes) * 60_000
  const interactive = process.stdin.isTTY === true
  const terminal = terminalChannel(process.stdin, process.stderr)
  const run = gh(repo)
  const deps = await nodeDevelop({
    channel: interactive ? terminal : fileChannel(resolve(runsDir, input.runId)),
    ci: { pollMs, startMs: ciStartMs, waitMs },
    credentials,
    input,
    log: (line) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${line}`),
    module: await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve('nanocode-ts/nanocode_wasm.wasm')))),
    pulls: ghPullRequests(repo, input.baseRef),
    repo,
    async reviewChannel(pr) {
      if (interactive) return terminal
      const answerers = input.config.answerers ?? [(await run(['api', 'user', '--jq', '.login'])).trim()]
      return commentChannel({ answerers, comments: ghComments(run, pr), pollMs, waitMs })
    },
    runsDir,
  })
  deps.ledger.put('repo', repo)
  try {
    const result = await develop(input, deps)
    console.log(`${result.status.toUpperCase()}: ${join(deps.dir, 'report.md')}${result.pr ? `\n${result.pr.url}` : ''}`)
    return result.status === 'ready' ? 0 : 1
  } catch (error) {
    if (!(error instanceof PausedError)) throw error
    console.log(`paused: ${error.message}`)
    console.log(`Resume with: npm run develop -- --run ${input.runId}`)
    return pausedExitCode
  }
}

function resumeInput(runsDir: string, runId: string): { input: DevelopInput; repo: string } {
  const path = join(runsDir, runId, 'state.json')
  if (!existsSync(path)) throw new StopError(`no run ${runId} in ${runsDir}`)
  const ledger = fileLedger(path)
  const input = ledger.get<DevelopInput>('input')
  const repo = ledger.get<string>('repo')
  if (!input || !repo) throw new StopError(`run ${runId} has no recorded input`)
  return { input, repo }
}

type Values = Record<string, string | boolean | undefined>

async function newInput(values: Values): Promise<{ input: DevelopInput; repo: string }> {
  const repo = resolve(String(values.repo ?? process.cwd()))
  const config = loadRepoConfig(join(repo, repoConfigFile))
  const ask = values['ask-file'] ? readFileSync(String(values['ask-file']), 'utf8') : (values.ask as string | undefined)
  if (!ask?.trim()) throw new StopError('give the ask with --ask or --ask-file')
  const parallel = values.parallel !== undefined ? parseParallel(String(values.parallel)) : undefined
  const baseRef = String(values.base ?? 'main')
  await git(repo, 'fetch', 'origin', baseRef)
  const base = (await git(repo, 'rev-parse', '--verify', `origin/${baseRef}^{commit}`)).trim()
  type Overrides = { develop?: Partial<DevelopModels>; review?: Partial<LoopModels> }
  const overrides = values.models ? (JSON.parse(readFileSync(String(values.models), 'utf8')) as Overrides) : {}
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const input: DevelopInput = {
    allowedModels: allowedModelsFrom(process.env.ALLOWED_MODELS),
    ask,
    base,
    baseRef,
    config,
    models: { develop: { ...defaultDevelopModels, ...overrides.develop }, review: mergeModels(overrides.review ?? {}) },
    runId: `dev-${stamp}`,
    source: `${repo} on ${baseRef}`,
    ...(values.hotfix ? { hotfix: true } : {}),
    ...(values.full ? { full: true } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
  }
  return { input, repo }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof StopError) console.error(`stop: ${error.message}`)
    else console.error(error)
    process.exit(2)
  },
)
