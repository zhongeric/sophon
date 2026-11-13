import type { Contracts } from 'nanocode-ts'
import type { CiJob } from '../ci.ts'
import type { RepoConfig } from '../checks.ts'
import { build, intake, plan, writeSpec, type BuildLog, type DevelopContext } from '../develop-steps.ts'
import { step, type Ledger } from '../ledger.ts'
import { frozenAsk, renderPlan, route, routeQuestions, waves, type Intake, type Plan, type PlanTask, type Route } from '../plan.ts'
import type { AgentStore, Branch, Branches, Checker, Files, Guides, PullRequests } from '../platform.ts'
import { forbiddenPaths, presentProfiles, profilesById } from '../profiles.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, commentLimit, decisions, PausedError, type Answer, type Channel, type Question } from '../questions.ts'
import type { ModelChoice } from '../roles.ts'
import { StopError } from '../stop.ts'
import { allowedModels, checkAllowedModels, checkFamilySwap, providersOf, type Criterion, type LoopModels, type LoopResult } from './code-review-loop.ts'

export type DevelopModels = Record<'intake' | 'spec' | 'planner' | 'builder', ModelChoice>

const opus: ModelChoice = { provider: 'claude', model: 'claude-opus-5-5' }

/** Intake, spec, planner and builders run on Opus 5.5, the strongest writer of the allowed models (ALL-011). */
export const defaultDevelopModels: DevelopModels = { intake: opus, spec: opus, planner: { ...opus, thinking: 'high' }, builder: { ...opus, thinking: 'high' } }

export type DevelopInput = {
  runId: string
  /** The ask, verbatim (ALL-001). */
  ask: string
  /** The base commit, and the branch that the PR targets. */
  base: string
  baseRef: string
  /** What is developed, for the report, for example a path and a branch. */
  source: string
  config: RepoConfig
  models: { develop: DevelopModels; review: LoopModels }
  /** A small hotfix: the host takes every recommendation without asking (ALL-004). */
  hotfix?: boolean
  /** The full review loop, also for a docs or tests only change. */
  full?: boolean
  /** At most this many builders at the same time. */
  parallel?: number
}

export type ReviewRequest = { runId: string; ask: string; head: string; full: boolean; pr: number }

/** What the platform supplies. */
export type DevelopDeps = {
  module: WebAssembly.Module
  ledger: Ledger
  files: Files
  store: AgentStore
  guides: Guides
  credentials: Credentials
  dispatch?: Contracts.RuntimeOptions['dispatch']
  /** Where the user answers the intake and spec questions. */
  channel: Channel
  branches: Branches
  pulls: PullRequests
  /** The checks and tests of a branch, run in its worktree. */
  checker(branch: Branch): Checker
  /** Runs the code review loop on a commit of the run's branch. */
  review(request: ReviewRequest): Promise<LoopResult>
  /** How long to look for CI before the run pauses, how often, and how long CI can take to start. */
  ci: { waitMs: number; pollMs: number; startMs: number }
  log(line: string): void
}

export type DevelopStatus = 'ready' | 'failed' | 'blocked' | 'stopped'
/** `resume` says what the user does before the same run can go on, for example add CI. It is null when a new run is necessary. */
export type DevelopResult = { status: DevelopStatus; pr: { number: number; url: string } | null; branch: string | null; report: string; resume: string | null }

/** CI-fix rounds after the build, then a blocker (G6). */
export const ciFixRounds = 2
/** How long CI can take to start for a push of a commit that already has finished CI. */
const ciGraceMs = 3 * 60_000
/** The most that GitHub's clock and the host's clock can differ. */
const clockSkewMs = 30_000
const defaultParallel = 3

type Ci = { sha: string; state: 'pass' | 'fail' | 'none'; jobs: CiJob[]; failures: string }
type Review = { pass: boolean; head: string; final: string; branch: string; report: string }

/** The providers of every model that a development run uses: the development roles and the review loop. */
export function developProviders(models: DevelopInput['models']): Set<Provider> {
  return new Set([...providersOf(models.review), ...Object.values(models.develop).map((choice) => choice.provider)])
}

export function checkDevelopModels(models: DevelopModels): void {
  const refused = [...new Set(Object.values(models).map((choice) => choice.model))].filter((model) => !allowedModels.includes(model))
  if (refused.length > 0) throw new StopError(`models outside the allowed list (${allowedModels.join(', ')}): ${refused.join(', ')}`)
}

/**
 * The development workflow of the ship-quality-code skill, steps 0 to 9, with its order and hard rules in code:
 * intake and the user's confirmation, a spec for a larger change, one plan, builders for the plan's tasks (in
 * parallel when their files do not overlap, each on its own branch), a draft PR, CI with a fix budget, the code
 * review loop once or twice, CI again, and a ready PR only when every criterion holds. Every step is in the
 * ledger, so the same run ID resumes after a pause or a crash without repeating finished steps.
 */
export async function develop(input: DevelopInput, deps: DevelopDeps): Promise<DevelopResult> {
  checkAllowedModels(input.models.review)
  checkFamilySwap(input.models.review)
  checkDevelopModels(input.models.develop)
  const missing = [...developProviders(input.models)].filter((provider) => !deps.credentials[provider])
  if (missing.length > 0) throw new StopError(`no credential for ${missing.join(', ')}`)

  const { ledger, branches, pulls } = deps
  const models = input.models.develop
  ledger.put('input', input)
  const view = await branches.view(input.base)
  const active = profilesById(await step(ledger, 'profiles', async () => (await presentProfiles(async (path) => (await view.stat(`/${path}`)) !== null)).map((profile) => profile.id)))
  const context: DevelopContext = {
    host: { module: deps.module, store: deps.store, ledger, credentials: deps.credentials, dispatch: deps.dispatch, log: deps.log },
    config: input.config,
    guides: deps.guides,
    stackGuides: [...new Set(active.flatMap((profile) => profile.guides))],
    ask: input.ask,
  }
  const questions = asker(ledger, deps.channel, input.runId, deps.log)
  const ask = async (batch: string, list: Question[]): Promise<Answer[]> => {
    if (input.hotfix) return questions.recommend(batch, list)
    await questions.post(batch, list)
    return questions.wait(batch)
  }

  // What the report shows. Each stage fills its part.
  const state: ReportState = { input, intake: null, route: null, plan: null, branch: null, head: null, pr: null, built: [], fixes: [], cis: [], reviews: [] }
  const finish = async (status: DevelopStatus, criteria: Criterion[], note: string, resumable = false): Promise<DevelopResult> => {
    const report = renderReport(state, status, criteria, note, decisions(ledger))
    deps.files.write('report.md', report)
    // A resumed run can end with another result. The PR then gets the new report, but never the same report again.
    if (state.pr && ledger.get('commented') !== report) {
      await pulls.comment(state.pr.number, report.length > commentLimit ? `${report.slice(0, commentLimit)}\n\n(cut: see report.md of run ${input.runId})` : report)
      ledger.put('commented', report)
    }
    ledger.put('result', { status, pr: state.pr, branch: state.branch })
    return { status, pr: state.pr, branch: state.branch, report, resume: resumable ? note : null }
  }

  // 0. Intake: no plan and no code until the user confirms the ask (ALL-010).
  const intook = await step(ledger, 'intake', () => intake(context, 'intake', models.intake, view))
  state.intake = intook
  const routed = route(intook, await ask('intake', [...intook.questions, ...routeQuestions(intook)]))
  state.route = routed
  if (routed.stop) return finish('stopped', [], 'You stopped the run at intake.')

  // 1. Spec, for a larger change. Its decisions are one batch of questions, so the user can overrule them.
  let spec: string | null = null
  if (routed.spec) {
    const written = await step(ledger, 'spec', () => writeSpec(context, 'spec', models.spec, view))
    deps.files.write('spec.md', written.spec)
    spec = written.spec
    await ask('spec', written.decisions)
  }

  // 2. Plan: one planner writes the four parts, the profile sections and the tasks (D7).
  const planned = await step(ledger, 'plan', () => plan(context, 'plan', models.planner, view, [...new Set(active.flatMap((profile) => profile.planSections))], spec))
  state.plan = planned
  const planText = `# Plan\n\n${renderPlan(planned, { tasks: true })}`
  deps.files.write('plan.md', planText)
  const frozen = frozenAsk(input.ask, decisions(ledger), planned)

  // Build: one builder for each task, each on its own branch. A wave of tasks with separate files runs at the same time.
  const branchName = await step(ledger, 'branch', async () => {
    for (let n = 1; ; n++) {
      const name = `factory/dev-${intook.slug}${n > 1 ? `-${n}` : ''}`
      if (!(await branches.exists(name))) return name
    }
  })
  state.branch = branchName
  const dev = await branches.branch(branchName, input.base)
  const taskBranch = (task: PlanTask) => `factory/task-${input.runId}-${task.id}`
  const scheduled = waves(planned.tasks, input.parallel ?? defaultParallel)
  for (const [index, wave] of scheduled.entries()) {
    const from = await step(ledger, `wave.${index}`, () => dev.head())
    const logs = await Promise.all(
      wave.map((task) =>
        step(ledger, `build.${task.id}`, async () => {
          const branch = await branches.branch(taskBranch(task), from)
          return build(context, {
            id: `build.${task.id}`,
            turn: { request: 'task', key: `output:build.${task.id}` },
            model: models.builder,
            branch,
            scope: task.files,
            active,
            checker: deps.checker(branch),
            base: input.base,
            review: { '/ask.md': input.ask, '/plan.md': planText, '/task.md': renderTask(task, state.built) },
            prompt: buildPrompt(task),
            label: `agent-factory: ${task.id}`,
          })
        }),
      ),
    )
    state.built.push(...wave.map((task, position) => ({ task, log: logs[position]! })))
    const blocked = state.built.filter((entry) => entry.log.blocked.trim())
    if (blocked.length > 0) return finish('blocked', [], blocked.map((entry) => `Task ${entry.task.id} is blocked: ${entry.log.blocked}`).join('\n'))
    for (const task of wave)
      await step(ledger, `merge.${task.id}`, async () => {
        await dev.merge(taskBranch(task), `agent-factory: merge task ${task.id} (${input.runId})`)
        return dev.head()
      })
  }

  // Draft PR and CI. A red CI goes back to a builder, inside the budget (G6). CI and the review loop see the pushed commit.
  const publish = async () => {
    const local = await dev.head()
    const sha = await step(ledger, `push.${local}`, async () => {
      const at = Date.now()
      const pushed = await branches.push(dev)
      ledger.put(`pushed-at:${pushed}`, at)
      return pushed
    })
    state.head = sha
    return sha
  }
  const waitCi = async (name: string, sha: string): Promise<Ci> => {
    const result = await watchCi(ledger, pulls, deps.ci, name, sha)
    state.cis.push(result)
    return result
  }
  const pushed = await publish()
  state.pr = await step(ledger, 'pr', () => pulls.open({ head: branchName, title: intook.title, body: prBody(input, decisions(ledger), planText) }))
  let ci = await waitCi('ci.build.0', pushed)
  const fixer = planned.tasks.length === 1 ? `build.${planned.tasks[0]!.id}` : 'ci-fix'
  for (let round = 1; ci.state === 'fail' && round <= ciFixRounds; round++) {
    const failed = ci
    const log = await step(ledger, `ci-fix.${round}`, () =>
      build(context, {
        id: fixer,
        turn: { request: `ci-${round}`, key: `output:${fixer}:ci-${round}` },
        model: models.builder,
        branch: dev,
        scope: [...new Set(planned.tasks.flatMap((task) => task.files))],
        active,
        checker: deps.checker(dev),
        base: input.base,
        review: { '/ask.md': input.ask, '/plan.md': planText, '/ci-failure.txt': failed.failures },
        prompt: fixPrompt(round, failed),
        label: `agent-factory: CI fix ${round}`,
      }),
    )
    state.fixes.push(log)
    if (log.blocked.trim()) return finish('blocked', [], `The CI fix is blocked: ${log.blocked}`)
    ci = await waitCi(`ci.build.${round}`, await publish())
  }
  if (ci.state === 'none') return finish('blocked', [], noCi(ci.sha), true)
  if (ci.state === 'fail') return finish('blocked', [], `CI is still red on ${ci.sha.slice(0, 12)} after ${ciFixRounds} fix rounds.`)

  // 4 and 5. Freeze and the review loop, once or twice. The frozen package is the ask, the decisions and the plan.
  let head = ci.sha
  for (let pass = 1; pass <= routed.passes; pass++) {
    const at = head
    const review = await step(ledger, `review.${pass}`, async (): Promise<Review> => {
      const loop = await deps.review({ runId: `${input.runId}-review-${pass}`, ask: frozen, head: at, full: input.full === true, pr: state.pr!.number })
      return { pass: loop.pass, head: at, final: loop.final, branch: loop.branch, report: loop.report }
    })
    state.reviews.push(review)
    if (review.final !== at) {
      await step(ledger, `merge.review.${pass}`, async () => {
        await dev.merge(review.final, `agent-factory: review loop fixes, pass ${pass} (${input.runId})`)
        return dev.head()
      })
      head = await publish()
    }
    if (!review.pass) break
  }

  // 7 and 8. Hygiene and CI on the final head. Fixes after the review do not pass through the review.
  // Thus, a red CI here fails the run.
  const reviewed = state.reviews.length === routed.passes && state.reviews.every((review) => review.pass)
  const final = await publish()
  const finalCi = !reviewed ? null : final === ci.sha ? ci : await waitCi('ci.final', final)
  if (finalCi?.state === 'none') return finish('blocked', [], noCi(final), true)
  const changed = await dev.changedFiles(input.base, final)
  const forbidden = forbiddenPaths(changed, active)
  const solidity = active.find((profile) => profile.id === 'solidity')
  const audit = solidity !== undefined && changed.some((path) => solidity.files.test(path))
  const criteria: Criterion[] = [
    { name: 'Ask confirmed', ok: true, detail: input.hotfix ? 'hotfix: the host took every recommendation (ALL-004)' : 'you answered the intake questions' },
    { name: 'Plan with its four parts', ok: true, detail: `${planned.tasks.length} tasks in ${scheduled.length} waves` },
    { name: 'Every task built', ok: true, detail: state.built.map((entry) => entry.task.id).join(', ') },
    {
      name: `Review loop PASS, ${routed.passes} of ${routed.passes} passes`,
      ok: reviewed,
      detail: state.reviews.map((review, index) => `pass ${index + 1}: ${review.pass ? 'PASS' : 'FAIL'}`).join(', '),
    },
    {
      name: 'CI green on the head',
      ok: finalCi?.state === 'pass',
      detail: finalCi ? `${final.slice(0, 12)}: ${finalCi.jobs.map((job) => `${job.name}=${job.ok ? 'pass' : 'fail'}`).join(', ')}` : 'not checked: the review loop did not pass',
    },
    { name: 'No build output, logs or environment files', ok: forbidden.length === 0, detail: forbidden.join(', ') || 'none in the change' },
    ...(audit ? [{ name: 'Auditor for Solidity src/', ok: false, detail: 'required (SOL-052), not built yet. Audit the change before you merge. The PR stays draft.' }] : []),
  ]
  const pass = criteria.every((criterion) => criterion.ok)
  if (pass) await step(ledger, 'ready', async () => (await pulls.ready(state.pr!.number), true))
  return finish(pass ? 'ready' : 'failed', criteria, pass ? 'Ready for your review. You merge.' : 'The PR stays draft.')
}

/**
 * Waits for the CI of a commit. A commit can already have CI from another branch, for example the review loop's
 * branch, while the runs of the push to the run's branch and of the PR have not started yet. So the host waits for
 * a job that started after the push, and takes the older jobs alone only after a grace period. A result without CI
 * is not recorded, so a resumed run looks again.
 */
async function watchCi(ledger: Ledger, pulls: PullRequests, timing: DevelopDeps['ci'], name: string, sha: string): Promise<Ci> {
  const recorded = ledger.get<Ci>(`ci:${name}`)
  if (recorded) return recorded
  const startedKey = `ci-started:${sha}`
  const started = ledger.get<number>(startedKey) ?? Date.now()
  ledger.put(startedKey, started)
  const pushedAt = ledger.get<number>(`pushed-at:${sha}`) ?? 0
  const deadline = Date.now() + timing.waitMs
  for (;;) {
    const jobs = await pulls.ci(sha)
    const fresh = jobs.some((job) => Date.parse(job.created) >= pushedAt - clockSkewMs)
    if (jobs.length > 0 && jobs.every((job) => job.done) && (fresh || Date.now() - pushedAt >= ciGraceMs)) {
      const failed = jobs.filter((job) => !job.ok)
      const logs = await Promise.all(failed.map(async (job) => `## ${job.name}\n${job.url}\n\n${await pulls.failureLog(job)}`))
      const ci: Ci = { sha, state: failed.length > 0 ? 'fail' : 'pass', jobs, failures: logs.join('\n\n') }
      ledger.put(`ci:${name}`, ci)
      return ci
    }
    if (jobs.length === 0 && Date.now() - started >= timing.startMs) return { sha, state: 'none', jobs: [], failures: '' }
    if (Date.now() >= deadline) {
      const pending = jobs.filter((job) => !job.done).map((job) => job.name)
      throw new PausedError(`waiting for CI on ${sha.slice(0, 12)}${pending.length ? `: ${pending.join(', ')}` : ' to start'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs))
  }
}

const noCi = (sha: string) => `No CI ran on ${sha.slice(0, 12)}. Add CI that runs on pull requests, push again, and resume the run.`

function buildPrompt(task: PlanTask): string {
  return [
    `Build task ${task.id}: ${task.title}.`,
    '',
    '- The task: /review/task.md',
    '- The plan: /review/plan.md',
    '- The ask: /review/ask.md',
    `- Files that you may write: ${task.files.join(', ')}`,
    '',
    'Checkpoint your work, then call submit_build_log one time.',
  ].join('\n')
}

function fixPrompt(round: number, ci: Ci): string {
  return [
    `Fix the CI failure, round ${round} of ${ciFixRounds}. CI failed on ${ci.sha.slice(0, 12)}: ${ci.jobs.filter((job) => !job.ok).map((job) => job.name).join(', ')}.`,
    '',
    '- The failure logs: /review/ci-failure.txt',
    '- The plan: /review/plan.md',
    '- The ask: /review/ask.md',
    '',
    'Fix the cause, not the check. Checkpoint, then call submit_build_log one time.',
  ].join('\n')
}

function renderTask(task: PlanTask, built: { task: PlanTask; log: BuildLog }[]): string {
  const finished = built.filter((entry) => task.depends_on.includes(entry.task.id))
  return [
    `# Task ${task.id}: ${task.title}`,
    '',
    `Files that you may write: ${task.files.map((path) => `\`${path}\``).join(', ')}`,
    '',
    task.work,
    ...(finished.length > 0
      ? ['', '## Finished tasks that this task builds on', '', ...finished.map((entry) => `- ${entry.task.id}: ${entry.log.summary} (${entry.log.changes.map((change) => change.path).join(', ')})`)]
      : []),
    '',
  ].join('\n')
}

/** The PR description: the frozen package, written by the host (G7). */
function prBody(input: DevelopInput, answers: Answer[], planText: string): string {
  return [
    `agent-factory run \`${input.runId}\` (${input.source}) opened this draft PR. It stays draft until the review loop passes and CI is green.`,
    '',
    '# Ask',
    '',
    ...input.ask.trim().split('\n').map((line) => `> ${line}`),
    '',
    ...(answers.length > 0 ? ['# Decisions of the user', '', ...answers.map((answer) => `- ${answer.question} **${answer.answer}**`), ''] : []),
    planText,
  ].join('\n')
}

type ReportState = {
  input: DevelopInput
  intake: Intake | null
  route: Route | null
  plan: Plan | null
  branch: string | null
  head: string | null
  pr: { number: number; url: string } | null
  built: { task: PlanTask; log: BuildLog }[]
  fixes: BuildLog[]
  cis: Ci[]
  reviews: Review[]
}

function renderReport(state: ReportState, status: DevelopStatus, criteria: Criterion[], note: string, answers: Answer[]): string {
  const triage = (report: string) => /^- Triage: (.*)$/m.exec(report)?.[1] ?? ''
  return [
    `# Development run: ${status.toUpperCase()}`,
    '',
    `- Run: ${state.input.runId}`,
    `- Source: ${state.input.source}`,
    ...(state.intake ? [`- Title: ${state.intake.title}`] : []),
    ...(state.route ? [`- Route: ${state.route.spec ? 'spec, then plan' : 'plan'}, ${state.route.passes} review loop ${state.route.passes === 1 ? 'pass' : 'passes'}. ${state.intake?.reason ?? ''}`] : []),
    ...(state.branch ? [`- Branch: ${state.branch}${state.head ? ` at ${state.head.slice(0, 12)}` : ''}`] : []),
    ...(state.pr ? [`- PR: ${state.pr.url}`] : []),
    '',
    note,
    '',
    ...(criteria.length > 0 ? ['## Criteria', '', ...criteria.map((criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}: ${criterion.detail}`), ''] : []),
    ...(state.plan ? ['## Plan', '', state.plan.smallest_change, ''] : []),
    ...(state.built.length > 0
      ? ['## Tasks', '', ...state.built.map((entry) => `- ${entry.task.id}: ${entry.log.blocked.trim() ? `blocked: ${entry.log.blocked}` : entry.log.summary}`), '']
      : []),
    ...(state.cis.length > 0
      ? [
          '## CI',
          '',
          ...state.cis.map((ci) => `- ${ci.sha.slice(0, 12)}: ${ci.state}${ci.jobs.length ? ` (${ci.jobs.map((job) => `${job.name}=${job.ok ? 'pass' : 'fail'}`).join(', ')})` : ''}`),
          ...state.fixes.map((log, index) => `- CI fix ${index + 1}: ${log.blocked.trim() ? `blocked: ${log.blocked}` : log.summary}`),
          '',
        ]
      : []),
    ...(state.reviews.length > 0
      ? [
          '## Review loop',
          '',
          ...state.reviews.map(
            (review, index) =>
              `- Pass ${index + 1}: ${review.pass ? 'PASS' : 'FAIL'}, ${triage(review.report)}, ${review.final === review.head ? 'no fixes' : `fixes merged from ${review.branch}`}`,
          ),
          '',
        ]
      : []),
    '## Your decisions',
    '',
    ...(answers.length > 0 ? answers.map((answer) => `- ${answer.question} **${answer.answer}**${answer.recommended ? ' (recommended)' : ''}`) : ['- none asked']),
    '',
  ].join('\n')
}
