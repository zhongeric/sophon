import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { repoConfigFile } from '../core/checks.ts'
import type { Credentials } from '../core/providers.ts'
import { commentChannel, PausedError, type Channel } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { codeReviewLoop, defaultModels, mergeModels, providersOf, type LoopInput, type LoopModels } from '../core/workflows/code-review-loop.ts'
import { fileChannel, gh, ghComments, terminalChannel } from './channels.ts'
import { credential } from './credentials.ts'
import { git, type GitSource } from './git.ts'
import { fileLedger } from './ledger.ts'
import { loadRepoConfig, nodeRun } from './platform.ts'

const exec = promisify(execFile)
const defaultWaitMinutes = 60
const pollMs = 30_000
const pausedExitCode = 3

const usage = `Usage: npm run review -- [options]

Runs the code review loop on a change and leaves the fixes on a local branch, factory/<run>.

Target (one of):
  --pr <number>          Review a GitHub PR of --repo: base, head and ask come from the PR
  --base <ref>           Review --head (default HEAD) against this base

Options:
  --repo <path>          Repository to review (default: current directory)
  --ask <text>           The original ask, verbatim (default with --pr: PR title and body)
  --ask-file <path>      Read the original ask from a file
  --stack <text>         Override the stack from ${repoConfigFile}
  --config <path>        Repository config (default: <repo>/${repoConfigFile})
  --models <path>        JSON file that overrides the default models per step and role
  --run <id>             Resume a run; other target options come from its ledger
  --runs-dir <path>      Where runs live (default: <agent-factory>/runs)
  --claude-plan          Sign Claude requests with the nc Claude login instead of ANTHROPIC_API_KEY
  --full                 Run the full loop, also when triage allows the light loop for a docs or tests only change
  --ship                 With --pr, on PASS: push the fixes to the PR branch and mark it ready
  --wait <minutes>       With --pr, how long to wait for answers before the run pauses (default 60)

Questions for you go to the PR as a comment with --pr, to the terminal when it is interactive,
and to a file in the run directory otherwise. A run that waits for answers exits with status 3;
resume it with --run <id> after you answer.

Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY`

async function main(): Promise<number> {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      ask: { type: 'string' },
      'ask-file': { type: 'string' },
      base: { type: 'string' },
      'claude-plan': { type: 'boolean' },
      config: { type: 'string' },
      full: { type: 'boolean' },
      head: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      models: { type: 'string' },
      pr: { type: 'string' },
      repo: { type: 'string' },
      run: { type: 'string' },
      'runs-dir': { type: 'string' },
      ship: { type: 'boolean' },
      stack: { type: 'string' },
      wait: { type: 'string' },
    },
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const runsDir = resolve(values['runs-dir'] ?? fileURLToPath(new URL('../../runs/', import.meta.url)))
  const { input, source } = values.run ? resumeInput(runsDir, values.run) : await newInput(values)

  const credentials: Credentials = {}
  for (const provider of providersOf(input.models)) credentials[provider] = credential(provider, { claudePlan: values['claude-plan'] })

  const wasm = fileURLToPath(import.meta.resolve('nanocode-ts/nanocode_wasm.wasm'))
  const waitMs = Number(values.wait ?? defaultWaitMinutes) * 60_000
  const run = await nodeRun({ config: input.config, runId: input.runId, runsDir, source })
  run.ledger.put('git', source)
  let result: Awaited<ReturnType<typeof codeReviewLoop>>
  try {
    result = await codeReviewLoop(input, {
      ...run,
      channel: await channel(input, source.repo, run.dir, waitMs),
      credentials,
      log: (line) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${line}`),
      module: await WebAssembly.compile(readFileSync(wasm)),
    })
  } catch (error) {
    if (!(error instanceof PausedError)) throw error
    console.log(`paused: ${error.message}`)
    console.log(`After you answer, resume with: npm run review -- --run ${input.runId}`)
    return pausedExitCode
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'}: ${join(run.dir, 'report.md')}`)
  for (const criterion of result.criteria) console.log(`  [${criterion.ok ? 'x' : ' '}] ${criterion.name}`)
  console.log(`Fixes are on ${result.branch}. Apply them with: git -C ${source.repo} merge --ff-only ${result.branch}`)
  return result.pass ? 0 : 1
}

export function resumeInput(runsDir: string, runId: string): { input: LoopInput; source: GitSource } {
  const path = join(runsDir, runId, 'state.json')
  if (!existsSync(path)) throw new StopError(`no run ${runId} in ${runsDir}`)
  const ledger = fileLedger(path)
  const input = ledger.get<LoopInput>('input')
  const source = ledger.get<GitSource>('git')
  if (!input || !source) throw new StopError(`run ${runId} has no recorded input`)
  // A run that started before a model role existed has no choice for it: use the default.
  return { input: { ...input, models: mergeModels(input.models) }, source }
}

type Values = Record<string, string | boolean | undefined>

async function newInput(values: Values): Promise<{ input: LoopInput; source: GitSource }> {
  const repo = resolve(String(values.repo ?? process.cwd()))
  const config = loadRepoConfig(resolve(String(values.config ?? join(repo, repoConfigFile))))
  const models = values.models ? mergeModels(JSON.parse(readFileSync(String(values.models), 'utf8')) as Partial<LoopModels>) : defaultModels
  let { base, head, ask } = { base: values.base as string | undefined, head: (values.head as string | undefined) ?? 'HEAD', ask: values.ask as string | undefined }
  if (values['ask-file']) ask = readFileSync(String(values['ask-file']), 'utf8')
  let ship: LoopInput['ship']
  let prNumber: number | undefined
  if (values.pr) {
    const pr = Number(values.pr)
    const { stdout } = await exec('gh', ['pr', 'view', String(pr), '--json', 'title,body,baseRefName,headRefName,headRefOid'], { cwd: repo })
    const view = JSON.parse(stdout) as { title: string; body: string; baseRefName: string; headRefName: string; headRefOid: string }
    await git(repo, 'fetch', 'origin', view.baseRefName, `refs/pull/${pr}/head`)
    base = `origin/${view.baseRefName}`
    head = view.headRefOid
    ask ??= `${view.title}\n\n${view.body}`
    prNumber = pr
    if (values.ship) ship = { pr, headRef: view.headRefName }
  } else if (values.ship) throw new StopError('--ship needs --pr')
  if (!base) throw new StopError('give --pr or --base')
  if (!ask?.trim()) throw new StopError('give the original ask with --ask or --ask-file')
  const headSha = (await git(repo, 'rev-parse', '--short=8', `${head}^{commit}`)).trim()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const input: LoopInput = {
    ask,
    config,
    models,
    runId: `${stamp}-${headSha}`,
    source: `${repo} ${base}..${head}`,
    ...(values.stack ? { stack: String(values.stack) } : {}),
    ...(prNumber ? { pr: prNumber } : {}),
    ...(ship ? { ship } : {}),
    ...(values.full ? { full: true } : {}),
  }
  return { input, source: { base, head, repo } }
}

/** The PR when there is one, the terminal when it is interactive, a file in the run directory otherwise. */
async function channel(input: LoopInput, repo: string, runDir: string, waitMs: number): Promise<Channel> {
  if (input.pr) {
    const run = gh(repo)
    const answerers = input.config.answerers ?? [(await run(['api', 'user', '--jq', '.login'])).trim()]
    return commentChannel({ answerers, comments: ghComments(run, input.pr), pollMs, waitMs })
  }
  return process.stdin.isTTY ? terminalChannel(process.stdin, process.stderr) : fileChannel(runDir)
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
