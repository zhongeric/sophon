import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { repoConfigFile } from '../core/checks.ts'
import { parseParallel } from '../core/plan.ts'
import { defaultEndpoints, type Credentials } from '../core/providers.ts'
import { commentChannel, PausedError, type Channel } from '../core/questions.ts'
import type { ModelChoice } from '../core/roles.ts'
import { StopError } from '../core/stop.ts'
import { parseBudget, parsePrices } from '../core/usage.ts'
import { allowedModelsFrom, mergeModels } from '../core/workflows/code-review-loop.ts'
import { defaultResearchModels, research, researchProviders, type ResearchInput, type ResearchModels } from '../core/workflows/research.ts'
import { fileChannel, gh, ghComments, terminalChannel } from './channels.ts'
import { credential } from './credentials.ts'
import { git } from './git.ts'
import { ghPullRequests } from './github.ts'
import { fileLedger } from './ledger.ts'
import { nodeResearch } from './platform.ts'

const defaultWaitMinutes = 60
const pollMs = 10_000
const pausedExitCode = 3
const command = 'node --disable-warning=ExperimentalWarning src/node/research.ts'

const usage = `Usage: ${command} --program <text> [options]

Runs the research workflow on a notebook: intake and your confirmation, the surveys, two generators on two model
families, your pick, and one prereg for each pick. You approve each prereg before the host freezes it on the branch
factory/research-<run>. Then each prereg gets an analysis, a calibration, skeptics and an analyst, and a dossier.
After the reproduction on a clean checkout, the run pushes factory/research-<run> and opens a dossier PR with one
review loop pass. Stage 11 needs the gh CLI login (gh auth login).

Options:
  --repo <path>          The notebook (default: current directory). Its ${repoConfigFile} at the base needs a
                         "research" field.
  --program <text>       The research program, verbatim
  --program-file <path>  Read the program from a file
  --base <branch>        The branch to read the config from and to branch from (default: main)
  --run <id>             Resume a run; the other options come from its ledger
  --runs-dir <path>      Where runs live (default: <agent-factory>/runs)
  --parallel <n>         At most n surveyors or preregistrars at the same time (default 3)
  --models <path>        JSON that overrides models: { "surveyor": ..., "generators": [..., ...], "skeptic": ... }
  --claude-plan          Sign Claude requests with the nc Claude login instead of ANTHROPIC_API_KEY
  --wait <minutes>       How long to wait for answers before the run pauses (default 60)
  --budget <usd>         Cost budget in USD. The cap that you give at intake replaces it. With --run, it replaces
                         the recorded budget.

Questions go to the terminal when it is interactive, else to a file in the run directory, and the review questions
go to the PR. A paused run exits with status 3; resume it with --run <id>.

Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, the secrets that the research config names, ALLOWED_MODELS (model
IDs, comma-separated), MODEL_PRICES (JSON: USD per million tokens of each model ID, see README.md).`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      budget: { type: 'string' },
      'claude-plan': { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      models: { type: 'string' },
      parallel: { type: 'string' },
      program: { type: 'string' },
      'program-file': { type: 'string' },
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
  const budget = values.budget !== undefined ? parseBudget(values.budget) : undefined
  const waitMs = parseWait(values.wait ?? String(defaultWaitMinutes))
  const prices = parsePrices(process.env.MODEL_PRICES)
  const runsDir = resolve(values['runs-dir'] ?? fileURLToPath(new URL('../../runs/', import.meta.url)))
  const started = values.run ? resumeInput(runsDir, values.run) : await newInput(values, budget)
  const { repo } = started
  // On a resume, a new budget replaces the recorded one. Without it, the recorded budget or the cap from the intake stays.
  const input: ResearchInput = values.run && budget !== undefined ? { ...started.input, budgetOverride: budget } : started.input

  const credentials: Credentials = {}
  for (const provider of researchProviders(input.models)) credentials[provider] = credential(provider, { claudePlan: values['claude-plan'] })
  const dir = resolve(runsDir, input.runId)
  const interactive = process.stdin.isTTY === true
  const terminal = terminalChannel(process.stdin, process.stderr)
  const run = gh(repo)
  const deps = await nodeResearch({
    channel: interactive ? terminal : waiting(fileChannel(dir), waitMs),
    credentials,
    input,
    log: (line) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${line}`),
    module: await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve('nanocode-ts/nanocode_wasm.wasm')))),
    prices,
    pulls: ghPullRequests(repo, input.baseRef),
    repo,
    async reviewChannel(pr) {
      if (interactive) return terminal
      const answerers = deps.config.answerers ?? [(await run(['api', 'user', '--jq', '.login'])).trim()]
      return commentChannel({ answerers, comments: ghComments(run, pr), pollMs, waitMs })
    },
    runsDir,
  })
  deps.ledger.put('repo', repo)
  try {
    const result = await research(input, deps)
    console.log(`${result.status.toUpperCase()}: ${join(deps.dir, 'report.md')}${result.branch ? `\nbranch: ${result.branch}` : ''}${result.pr ? `\n${result.pr.url}` : ''}`)
    return result.status === 'ready' ? 0 : 1
  } catch (error) {
    if (!(error instanceof PausedError)) throw error
    console.log(`paused: ${error.message}`)
    console.log(`Resume with: ${command} --run ${input.runId}`)
    return pausedExitCode
  }
}

/** The --wait option in milliseconds. A value that is not a number of 0 or more minutes stops the run. */
export function parseWait(text: string): number {
  const minutes = text.trim() === '' ? Number.NaN : Number(text)
  if (!Number.isFinite(minutes) || minutes < 0) throw new StopError(`--wait must be a number of minutes of 0 or more, not ${JSON.stringify(text)}`)
  return minutes * 60_000
}

/** Reads the answers file again until `waitMs` ends, so that the user can reply while the run waits. */
function waiting(channel: Channel, waitMs: number): Channel {
  return {
    ...channel,
    async answers(posted, questions) {
      const deadline = Date.now() + waitMs
      for (;;) {
        const answers = await channel.answers(posted, questions)
        if (answers !== null || Date.now() >= deadline) return answers
        await sleep(Math.min(pollMs, deadline - Date.now()))
      }
    },
  }
}

/** The recorded input of a run. An older run recorded fewer roles, so the new roles get the default models. */
export function resumeInput(runsDir: string, runId: string): { input: ResearchInput; repo: string } {
  const path = join(runsDir, runId, 'state.json')
  if (!existsSync(path)) throw new StopError(`no run ${runId} in ${runsDir}`)
  const ledger = fileLedger(path)
  const input = ledger.get<ResearchInput>('input')
  const repo = ledger.get<string>('repo')
  if (!input || !repo) throw new StopError(`run ${runId} has no recorded input`)
  return { input: { ...input, models: { ...defaultResearchModels, ...input.models, review: mergeModels(input.models.review ?? {}) } }, repo }
}

type Values = Record<string, string | boolean | undefined>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function modelChoice(value: unknown, where: string): ModelChoice {
  const shape = `${where} must be { "provider": ${Object.keys(defaultEndpoints).map((name) => JSON.stringify(name)).join(' or ')}, "model": <ID>, "thinking"?: "low" or "medium" or "high" }`
  if (!isObject(value)) throw new StopError(shape)
  const { provider, model, thinking, ...rest } = value
  if (typeof provider !== 'string' || !Object.hasOwn(defaultEndpoints, provider) || typeof model !== 'string' || model === '') throw new StopError(shape)
  if (thinking !== undefined && thinking !== 'low' && thinking !== 'medium' && thinking !== 'high') throw new StopError(shape)
  if (Object.keys(rest).length > 0) throw new StopError(shape)
  // The keys of defaultEndpoints are the providers.
  return { provider: provider as ModelChoice['provider'], model, ...(thinking !== undefined ? { thinking } : {}) }
}

/** The roles of a models file with one model each. The review loop keeps its default models. */
const singleRoles = ['intake', 'surveyor', 'preregistrar', 'builder', 'skeptic', 'lateSkeptic', 'analyst', 'writer'] as const
const isSingleRole = (role: string): role is (typeof singleRoles)[number] => (singleRoles as readonly string[]).includes(role)

/** The models of a --models file over the defaults. A file with another shape stops the run before any work. */
export function researchModels(text: string, source: string): ResearchModels {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new StopError(`--models ${source} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isObject(parsed)) throw new StopError(`--models ${source} must be a JSON object of roles`)
  const models = { ...defaultResearchModels }
  for (const [role, value] of Object.entries(parsed)) {
    if (role === 'generators') {
      if (!Array.isArray(value) || value.length !== 2) throw new StopError(`--models ${source}: generators must be a list of two models`)
      models.generators = [modelChoice(value[0], `--models ${source}: generators[0]`), modelChoice(value[1], `--models ${source}: generators[1]`)]
    } else if (isSingleRole(role)) models[role] = modelChoice(value, `--models ${source}: ${role}`)
    else throw new StopError(`--models ${source}: ${role} is not a research role (${['generators', ...singleRoles].join(', ')})`)
  }
  return models
}

/** The input of a new run. A --budget value is the budget before the intake, so the cap of the intake replaces it. */
export async function newInput(values: Values, budget?: number): Promise<{ input: ResearchInput; repo: string }> {
  const repo = resolve(String(values.repo ?? process.cwd()))
  const program = values['program-file'] ? readFileSync(String(values['program-file']), 'utf8') : (values.program as string | undefined)
  if (!program?.trim()) throw new StopError('give the program with --program or --program-file')
  const parallel = values.parallel !== undefined ? parseParallel(String(values.parallel)) : undefined
  const baseRef = String(values.base ?? 'main')
  // The local branch, not origin: the run commits on a branch of this working copy, and pushes only at stage 11.
  const base = (await git(repo, 'rev-parse', '--verify', `${baseRef}^{commit}`)).trim()
  const models = values.models ? researchModels(readFileSync(String(values.models), 'utf8'), String(values.models)) : defaultResearchModels
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const input: ResearchInput = {
    allowedModels: allowedModelsFrom(process.env.ALLOWED_MODELS),
    base,
    baseRef,
    models,
    program,
    runId: `research-${stamp}`,
    source: `${repo} on ${baseRef}`,
    ...(parallel !== undefined ? { parallel } : {}),
    ...(budget !== undefined ? { budget } : {}),
  }
  return { input, repo }
}

if (fileURLToPath(import.meta.url) === process.argv[1])
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof StopError) console.error(`stop: ${error.message}`)
      else console.error(error)
      process.exit(2)
    },
  )
