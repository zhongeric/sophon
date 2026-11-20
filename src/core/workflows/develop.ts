import type { Contracts } from 'nanocode-ts'
import type { CiJob } from '../ci.ts'
import type { MergeMethod, RepoConfig } from '../checks.ts'
import { build, intake, plan, writeSpec, type BuildLog, type DevelopContext } from '../develop-steps.ts'
import { step, type Ledger } from '../ledger.ts'
import { alarmLines, settleAll } from '../planned-stop.ts'
import { frozenAsk, renderPlan, route, routeQuestions, waves, type Intake, type Plan, type PlanTask, type Route } from '../plan.ts'
import type { AgentStore, Branch, Branches, Checker, Files, Guides, MergeResult, PullRequests, Signing } from '../platform.ts'
import { forbiddenPaths, presentProfiles, profilesById } from '../profiles.ts'
import { branchesSection, pruneBranches, reasonOf, type BranchFacts, type BranchRun, type PruneResult } from '../prune.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, commentLimit, decisionLists, decisions, PausedError, type Answer, type Channel, type Question } from '../questions.ts'
import type { ModelChoice } from '../roles.ts'
import { signingLine, type SigningRecord } from '../signing.ts'
import { StopError } from '../stop.ts'
import { BudgetStop, belowBudget, budgetGate, checkPriced, resolveBudget, usageOf, usageSection, zeroTokens, type Prices, type RunUsage, type UsageRow } from '../usage.ts'
import { checkAllowedModels, checkFamilySwap, decisionSections, defaultAllowedModels, loopModelIds, providersOf, type Criterion, type LoopModels, type LoopResult } from './code-review-loop.ts'

export type DevelopModels = Record<'intake' | 'spec' | 'planner' | 'builder', ModelChoice>

const opus: ModelChoice = { provider: 'claude', model: 'claude-opus-5-5' }

/** Intake, spec, planner and builders run on Opus 5.5, the strongest writer of the allowed models. */
export const defaultDevelopModels: DevelopModels = { intake: opus, spec: opus, planner: { ...opus, thinking: 'high' }, builder: { ...opus, thinking: 'high' } }

export type DevelopInput = {
  runId: string
  /** The ask, verbatim. */
  ask: string
  /** The base commit, and the branch that the PR targets. */
  base: string
  baseRef: string
  /** What is developed, for the report, for example a path and a branch. */
  source: string
  config: RepoConfig
  models: { develop: DevelopModels; review: LoopModels }
  /** The models that the run accepts. Default: defaultAllowedModels. */
  allowedModels?: string[]
  /** A small hotfix: the host takes every recommendation without asking. */
  hotfix?: boolean
  /** The full review loop, also for a docs or tests only change. */
  full?: boolean
  /** At most this many builders at the same time. */
  parallel?: number
  /** The cost budget in USD, for the development agents and the review loop together. */
  budget?: number
  /** A budget of the current invocation, for example --budget on a resume. It replaces the budget, and the ledger does not record it. */
  budgetOverride?: number
  /** The issue that the PR closes. */
  issue?: number
}

/** `budget` is what remains up to twice the development budget, so that the review loop stops where the development gate pauses. `branch` is the PR head branch. */
export type ReviewRequest = { runId: string; ask: string; head: string; branch: string; full: boolean; pr: number; budget?: number }

/** What the platform supplies. */
export type DevelopDeps = {
  module: WebAssembly.Module
  ledger: Ledger
  files: Files
  store: AgentStore
  guides: Guides
  credentials: Credentials
  dispatch?: Contracts.RuntimeOptions['dispatch']
  /** USD per million tokens of each model, from MODEL_PRICES. Default: no prices. */
  prices?: Prices
  /** Where the user answers the intake and spec questions. */
  channel: Channel
  branches: Branches
  pulls: PullRequests
  signing: Signing
  /** The checks and tests of a branch, run in its worktree. */
  checker(branch: Branch): Checker
  /** Runs the code review loop on a commit of the run's branch. */
  review(request: ReviewRequest): Promise<LoopResult>
  /** How long to look for CI before the run pauses, how often, and how long CI can take to start. */
  ci: { waitMs: number; pollMs: number; startMs: number }
  log(line: string): void
}

export type DevelopStatus = 'ready' | 'failed' | 'blocked' | 'stopped'
/**
 * `resume` says what the user does before the same run can go on, for example add CI. It is null when a new run is
 * necessary. `merge` is null unless the host merged the PR.
 */
export type DevelopResult = {
  status: DevelopStatus
  pr: { number: number; url: string } | null
  branch: string | null
  report: string
  resume: string | null
  merge: { method: MergeMethod; sha: string } | null
}

/** Repair rounds of a run: one budget for all causes, CI failures and failed review passes. Then the run fails (D14, G6). */
export const repairRounds = 5
/** How long CI can take to start for a push of a commit that already has finished CI. */
const ciGraceMs = 3 * 60_000
/** The most that GitHub's clock and the host's clock can differ. */
const clockSkewMs = 30_000
const defaultParallel = 3

type Ci = { sha: string; state: 'pass' | 'fail' | 'none'; jobs: CiJob[]; failures: string }
/** A review pass. Records of older runs have no usage, which counts as zero, and no failed criteria. */
type Review = { pass: boolean; head: string; final: string; branch: string; report: string; usage?: RunUsage; failed?: Criterion[] }
/**
 * The cause of a repair round. `from` is 'CI' or 'review pass N', `short` is one line for the prompt and the report,
 * `text` is /review/repair.txt, and `logs` is /review/ci-failure.txt when CI failed.
 */
type Cause = { from: string; short: string; text: string; logs: string | null }
type Repair = { round: number; cause: Cause; log: BuildLog }

/** The providers of every model that a development run uses: the development roles and the review loop. */
export function developProviders(models: DevelopInput['models']): Set<Provider> {
  return new Set([...providersOf(models.review), ...Object.values(models.develop).map((choice) => choice.provider)])
}

export function checkDevelopModels(models: DevelopModels, allowed = defaultAllowedModels): void {
  const refused = [...new Set(Object.values(models).map((choice) => choice.model))].filter((model) => !allowed.includes(model))
  if (refused.length > 0) throw new StopError(`models outside the allowed list (${allowed.join(', ')}): ${refused.join(', ')}`)
}

/**
 * The development workflow, steps 0 to 9, with its order and hard rules in code:
 * intake and the confirmation of the ask, a spec for a larger change, one plan, builders for the plan's tasks (in
 * parallel when their files do not overlap, each on its own branch), a draft PR, CI, the code review loop once or
 * twice, CI again, and a ready PR only when every criterion holds. A red CI or a failed review pass gets a repair round
 * inside one budget, and a new review pass reviews the fixes (D14). Every step is in the ledger, so the same run ID
 * resumes after a pause or a crash without repeating finished steps. When the user stops the run at the cost budget, the
 * run ends as stopped with its report.
 */
export async function develop(input: DevelopInput, deps: DevelopDeps): Promise<DevelopResult> {
  const stop: { finish?: Finish } = {}
  try {
    return await developSteps(input, deps, stop)
  } catch (error) {
    if (error instanceof BudgetStop && stop.finish) return stop.finish('stopped', [], `The run ${error.message}. Reason: cost budget. The PR stays draft.`)
    throw error
  }
}

type Finish = (status: DevelopStatus, criteria: Criterion[], note: string, resumable?: boolean, merge?: DevelopResult['merge']) => Promise<DevelopResult>

/** The steps of develop(). It sets `stop.finish`, so that develop() can write the report of a run that stops at the budget. */
async function developSteps(input: DevelopInput, deps: DevelopDeps, stop: { finish?: Finish }): Promise<DevelopResult> {
  checkAllowedModels(input.models.review, input.allowedModels)
  checkFamilySwap(input.models.review)
  checkDevelopModels(input.models.develop, input.allowedModels)
  const missing = [...developProviders(input.models)].filter((provider) => !deps.credentials[provider])
  if (missing.length > 0) throw new StopError(`no credential for ${missing.join(', ')}`)
  const prices = deps.prices ?? {}
  if (resolveBudget(deps.ledger, input.budget, input.budgetOverride) !== undefined)
    checkPriced([...Object.values(input.models.develop).map((choice) => choice.model), ...loopModelIds(input.models.review)], prices)

  const { ledger, branches, pulls } = deps
  const models = input.models.develop
  // What the report shows. Each stage fills its part.
  const state: ReportState = { input, intake: null, route: null, plan: null, branch: null, signing: null, head: null, pr: null, built: [], repairs: [], cis: [], reviews: [], stoppedReview: null }
  const spentPasses = () => [...state.reviews, ...(state.stoppedReview ? [state.stoppedReview] : [])]
  // A hotfix, or the standing answers of the repository, takes every recommendation (D11).
  const recommend = input.hotfix === true || input.config.questions === 'recommended'
  // The review passes keep their usage in their own ledgers, so their rows count here as extra spend.
  const budget = budgetGate({
    channel: deps.channel,
    extraRows: () => spentPasses().map(reviewRow),
    ledger,
    log: deps.log,
    prices,
    recommend,
    runId: input.runId,
  })
  // A resume without --budget must not apply the override again, so the recorded input does not keep it.
  const { budgetOverride, ...recorded } = input
  ledger.put('input', recorded)
  // A run that deleted its development branch cannot go on: a resume starts the branch again from the base.
  const ended = ledger.get<DevelopResult>('ended')
  if (ended) return ended
  const view = await branches.view(input.base)
  const active = profilesById(await step(ledger, 'profiles', async () => (await presentProfiles(async (path) => (await view.stat(`/${path}`)) !== null)).map((profile) => profile.id)))
  const context: DevelopContext = {
    host: { module: deps.module, store: deps.store, ledger, credentials: deps.credentials, dispatch: deps.dispatch, log: deps.log, beforeTurn: budget.check },
    config: input.config,
    guides: deps.guides,
    stackGuides: [...new Set(active.flatMap((profile) => profile.guides))],
    ask: input.ask,
  }
  const questions = asker(ledger, deps.channel, input.runId, deps.log, { recommend })
  const ask = async (batch: string, list: Question[]): Promise<Answer[]> => {
    await questions.post(batch, list)
    return questions.wait(batch)
  }

  // The tasks whose merge step ran, and the result of the delete-branch step after a host merge.
  const mergedTasks = new Set<string>()
  let remoteDeleted: boolean | null = null
  const taskBranch = (task: PlanTask) => `factory/task-${input.runId}-${task.id}`
  const prune = async (merged: boolean): Promise<PruneResult> => {
    const pr = merged ? 'merged' : state.pr ? 'open' : null
    const own = (name: string, kind: BranchRun['kind'], applied: boolean, of: BranchFacts['pr']): BranchFacts => ({ name, run: { kind, finished: true, ship: false }, pr: of, applied, inDefault: false })
    // A stop in a wave leaves the task branches of that wave out of state.built, but they can exist.
    const built = new Set(state.built.map((entry) => entry.task.id))
    const unbuilt = (state.plan?.tasks ?? []).filter((task) => !built.has(task.id))
    const present = await Promise.all(unbuilt.map((task) => branches.exists(taskBranch(task)).catch(() => false)))
    const tasks = [...state.built.map((entry) => entry.task), ...unbuilt.filter((_, index) => present[index])]
    // A failed delete-branch step is already in the note, so the prune leaves that branch alone.
    const facts = [
      ...(state.branch && remoteDeleted !== false ? [own(state.branch, 'develop', false, pr)] : []),
      ...tasks.map((task) => own(taskBranch(task), 'task', mergedTasks.has(task.id), null)),
      // The run merged the fixes of each finished pass, or the pass had none.
      ...[...new Set(state.reviews.map((review) => review.branch))].map((name) => own(name, 'review', true, pr)),
    ]
    // A resumed run can end again. Only the branches that are not deleted yet go through the rules again.
    const earlier = ledger.get<PruneResult>('prune')
    const gone = new Set(earlier?.deleted.map((branch) => branch.name))
    const result = await pruneBranches(
      facts.filter((branch) => !gone.has(branch.name)),
      async (name) => {
        if (!(name === state.branch && remoteDeleted)) await branches.deleteRemote(name)
        await branches.deleteLocal(name)
      },
    )
    const all = { ...result, deleted: [...(earlier?.deleted ?? []), ...result.deleted] }
    ledger.put('prune', all)
    return all
  }

  const finish: Finish = async (status, criteria, note, resumable = false, merge = null) => {
    const limit = budget.limit()
    const usage = usageSection([...usageOf(ledger).agents, ...spentPasses().map(reviewRow)], prices, limit === undefined ? undefined : { limit, spent: budget.spent() })
    // A resumable run is not finished, so its branches and worktrees stay.
    const pruned = resumable ? null : await prune(merge !== null)
    const shown = resumable
      ? note
      : await branches.release().then(
          () => note,
          (error: unknown) => `${note} The host did not remove the worktrees of the run: ${reasonOf(error)}.`,
        )
    const report = renderReport(state, status, criteria, shown, decisions(ledger), usage, pruned ? branchesSection(pruned) : [], alarmLines(ledger))
    deps.files.write('report.md', report)
    // A resumed run can end with another result. The PR then gets the new report, but never the same report again.
    if (state.pr && ledger.get('commented') !== report) {
      await pulls.comment(state.pr.number, cutReport(report, `(cut: see report.md of run ${input.runId})`))
      ledger.put('commented', report)
    }
    ledger.put('result', { status, pr: state.pr, branch: state.branch, merge })
    const result = { status, pr: state.pr, branch: state.branch, report, resume: resumable ? note : null, merge }
    if (pruned?.deleted.some((branch) => branch.name === state.branch)) ledger.put('ended', result)
    return result
  }
  stop.finish = finish

  // 0. Intake: no plan and no code before the ask is confirmed. The route questions are run questions (D11), so the run
  // takes the recommendations of the intake agent. The run asks the user only when the intake agent raises a user question.
  const intook = await step(ledger, 'intake', () => intake(context, 'intake', models.intake, view))
  state.intake = intook
  const intakeAnswers = await ask('intake', [...intook.questions, ...routeQuestions(intook)])
  const routed = route(intook, intakeAnswers)
  state.route = routed
  if (routed.stop) return finish('stopped', [], 'You stopped the run at intake.')

  // 1. Spec, for a larger change. Its decisions are one batch of questions. Only its user questions go to the user (D11).
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
  // Before the first commit. The branch name comes from the intake slug, so the check cannot run before intake.
  const signing = await step(ledger, 'signing', () => deps.signing.check([branchName]))
  state.signing = signing
  await deps.signing.apply(signing)
  const dev = await branches.branch(branchName, input.base)
  const scheduled = waves(planned.tasks, input.parallel ?? defaultParallel)
  for (const [index, wave] of scheduled.entries()) {
    const from = await step(ledger, `wave.${index}`, () => dev.head())
    const builds = wave.map((task) =>
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
    )
    // All tasks must end before finish checks or deletes their branches.
    const logs = await settleAll(builds)
    state.built.push(...wave.map((task, position) => ({ task, log: logs[position]! })))
    const blocked = state.built.filter((entry) => entry.log.blocked.trim())
    if (blocked.length > 0) return finish('blocked', [], blocked.map((entry) => `Task ${entry.task.id} is blocked: ${entry.log.blocked}`).join('\n'))
    for (const task of wave) {
      await step(ledger, `merge.${task.id}`, async () => {
        await dev.merge(taskBranch(task), `agent-factory: merge task ${task.id} (${input.runId})`)
        return dev.head()
      })
      mergedTasks.add(task.id)
      // A delete is safe to repeat on a resume. When it fails, the prune at the end tries again and reports it.
      await branches.deleteLocal(taskBranch(task)).catch((error: unknown) => deps.log(`task branch ${taskBranch(task)} not deleted: ${reasonOf(error)}`))
    }
  }

  // Draft PR and CI. CI and the review loop see the pushed commit.
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
  state.pr = await step(ledger, 'pr', () => pulls.open({ head: branchName, title: intook.title, body: prBody(input, decisions(ledger), planText, planned.smallest_change) }))
  const fixer = planned.tasks.length === 1 ? `build.${planned.tasks[0]!.id}` : 'ci-fix'
  const repair = (round: number, cause: Cause) =>
    step(ledger, `repair.${round}`, () =>
      build(context, {
        id: fixer,
        turn: { request: `repair-${round}`, key: `output:${fixer}:repair-${round}` },
        model: models.builder,
        branch: dev,
        scope: [...new Set(planned.tasks.flatMap((task) => task.files))],
        active,
        checker: deps.checker(dev),
        base: input.base,
        review: { '/ask.md': input.ask, '/plan.md': planText, '/repair.txt': cause.text, ...(cause.logs === null ? {} : { '/ci-failure.txt': cause.logs }) },
        prompt: repairPrompt(round, cause),
        label: `agent-factory: repair ${round}`,
      }),
    )

  // 4 and 5. Freeze and the review loop. The frozen package is the ask, the decisions and the plan.
  // A pass gets the budget up to twice the run budget and stops there without a question. That stop is not a finished
  // step: the budget gate of this run then asks with the run totals, or raises the budget in a hotfix run.
  // After a raise, or on a resume with a higher budget, the same pass runs again with the new remaining budget.
  const reviewPass = async (pass: number, at: string): Promise<Review> => {
    const stoppedKey = `review-stopped.${pass}`
    const review = await step(ledger, `review.${pass}`, async (): Promise<Review> => {
      state.stoppedReview = ledger.get<Review>(stoppedKey) ?? null
      for (;;) {
        await budget.check()
        // After the check, the spend is below twice the limit, so the remaining budget is positive. The ledger of the pass
        // already counts the spend of its stopped attempt, so that spend is not taken from the remaining budget.
        const limit = budget.limit()
        const remaining = limit === undefined ? {} : { budget: 2 * limit - budget.spent() + (state.stoppedReview?.usage?.usd ?? 0) }
        const loop = await deps.review({ runId: `${input.runId}-review-${pass}`, ask: frozen, head: at, branch: branchName, full: input.full === true, pr: state.pr!.number, ...remaining })
        const failed = loop.criteria.filter((criterion) => !criterion.ok)
        const result: Review = { pass: loop.pass, head: at, final: loop.final, branch: loop.branch, report: loop.report, usage: loop.usage, failed }
        if (!loop.stopped) return result
        ledger.put(stoppedKey, result)
        state.stoppedReview = result
        // Below twice the run budget, the gate does not pause, so the pass cannot continue after a raise.
        if (limit === undefined || belowBudget(budget.spent(), 2 * limit)) throw new BudgetStop(`stopped at the cost budget in review loop pass ${pass}`)
      }
    })
    state.stoppedReview = null
    state.reviews.push(review)
    return review
  }

  // The repair loop (D14, G6). A red CI, a failed review pass and a red CI after the last PASS each give a cause to the
  // fixer session, inside one budget of repairRounds. CI runs after each round, and no review pass runs while CI is red.
  // The fixes of a repair always go through a new review pass. All control comes from ledger steps, so a resumed run
  // replays the loop and repeats no round.
  let head = pushed
  // The CI of the last checked commit. It checks the head only when its sha is the head.
  let ci = await waitCi('ci.build.0', head)
  // True when a repair came after the last review pass, so that its fixes need a new pass.
  let repaired = false
  // The cause that remains when the budget is used.
  let unrepaired: Cause | null = null
  for (;;) {
    if (ci.state === 'none') return finish('blocked', [], noCi(ci.sha), true)
    let cause: Cause
    if (ci.state === 'fail') cause = ciCause(ci)
    else if (state.reviews.length < routed.passes || state.reviews.at(-1)?.pass !== true || repaired) {
      const pass = state.reviews.length + 1
      const review = await reviewPass(pass, head)
      repaired = false
      if (review.final !== review.head) {
        await step(ledger, `merge.review.${pass}`, async () => {
          await dev.merge(review.final, `agent-factory: review loop fixes, pass ${pass} (${input.runId})`)
          return dev.head()
        })
        head = await publish()
      }
      if (review.pass) continue
      cause = reviewCause(pass, review)
    } else if (ci.sha !== head) {
      // 7 and 8. CI on the head after the last PASS.
      ci = await waitCi(`ci.final.${state.reviews.length}`, head)
      continue
    } else break
    if (state.repairs.length === repairRounds) {
      unrepaired = cause
      break
    }
    const round = state.repairs.length + 1
    const log = await repair(round, cause)
    state.repairs.push({ round, cause, log })
    if (log.blocked.trim()) return finish('blocked', [], `The repair is blocked: ${log.blocked}`)
    head = await publish()
    repaired = true
    ci = await waitCi(`ci.repair.${round}`, head)
  }

  // Hygiene and the criteria. When the budget is used, the run ends failed with the last cause.
  const reviewed = state.reviews.length >= routed.passes && state.reviews.at(-1)?.pass === true && !repaired
  const final = head
  const finalCi = ci.sha === final ? ci : null
  const changed = await dev.changedFiles(input.base, final)
  const forbidden = forbiddenPaths(changed, active)
  const solidity = active.find((profile) => profile.id === 'solidity')
  const audit = solidity !== undefined && changed.some((path) => solidity.files.test(path))
  const criteria: Criterion[] = [
    // The marks of the answers tell who confirmed the ask. A ledger from before D11 posted every question, also the route questions.
    {
      name: 'Ask confirmed',
      ok: true,
      detail: recommend
        ? `${input.hotfix ? 'hotfix' : 'standing answers'}: the host took every recommendation`
        : intakeAnswers.some((answer) => answer.decidedBy !== 'run')
          ? 'you answered the intake questions'
          : 'the run took the recommendations of the intake agent (D11)',
    },
    { name: 'Plan with its four parts', ok: true, detail: `${planned.tasks.length} tasks in ${scheduled.length} waves` },
    { name: 'Every task built', ok: true, detail: state.built.map((entry) => entry.task.id).join(', ') },
    {
      name: `Review loop PASS on the head, at least ${routed.passes} ${routed.passes === 1 ? 'pass' : 'passes'}`,
      ok: reviewed,
      detail: [
        ...state.reviews.map((review, index) => `pass ${index + 1}: ${review.pass ? 'PASS' : 'FAIL'}`),
        ...(state.reviews.length === 0 ? ['no pass ran'] : []),
        ...(repaired ? ['a repair after the last pass'] : []),
      ].join(', '),
    },
    {
      name: 'CI green on the head',
      ok: finalCi?.state === 'pass',
      detail: finalCi ? `${final.slice(0, 12)}: ${finalCi.jobs.map((job) => `${job.name}=${job.ok ? 'pass' : 'fail'}`).join(', ')}` : 'not checked: the review loop did not pass',
    },
    { name: 'No build output, logs or environment files', ok: forbidden.length === 0, detail: forbidden.join(', ') || 'none in the change' },
    ...(audit ? [{ name: 'Auditor for Solidity src/', ok: false, detail: 'required, not built yet. Audit the change before you merge. The PR stays draft.' }] : []),
  ]
  const pass = criteria.every((criterion) => criterion.ok)
  if (!pass) {
    const used = unrepaired ? `The run used its ${repairRounds} repair rounds. The last cause: ${unrepaired.from}, ${unrepaired.short}. ` : ''
    return finish('failed', criteria, `${used}The PR stays draft.`)
  }
  const pr = state.pr!.number
  await step(ledger, 'ready', async () => (await pulls.ready(pr), true))
  const method = input.config.merge
  if (!method) return finish('ready', criteria, 'Ready for your review. You merge.')

  // 9. The merge, only with the standing permission and only at the head that the final CI checked. The step records a
  // refusal as a result, so that a resumed run never tries the merge again.
  const merged = await step(ledger, 'merge', async (): Promise<MergeResult> => {
    try {
      return await pulls.merge(pr, { method, sha: final })
    } catch (error) {
      return { merged: false, reason: reasonOf(error) }
    }
  })
  if (!merged.merged) return finish('ready', criteria, `Not merged: ${merged.reason}. The PR stays ready for your review. You merge.`)
  const deleted = await step(ledger, 'delete-branch', async (): Promise<{ deleted: true } | { deleted: false; reason: string }> => {
    try {
      await branches.deleteRemote(branchName)
      return { deleted: true }
    } catch (error) {
      return { deleted: false, reason: reasonOf(error) }
    }
  })
  remoteDeleted = deleted.deleted
  const note = [
    `Merged by the host (${method}): ${merged.sha}.`,
    ...(deleted.deleted ? [] : [`The host did not delete the branch ${branchName}: ${deleted.reason}.`]),
  ].join(' ')
  return finish('ready', criteria, note, false, { method, sha: merged.sha })
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

function repairPrompt(round: number, cause: Cause): string {
  return [
    `Repair round ${round} of ${repairRounds}. The cause: ${cause.from}, ${cause.short}.`,
    '',
    '- The causes: /review/repair.txt',
    ...(cause.logs === null ? [] : ['- The CI logs: /review/ci-failure.txt']),
    '- The plan: /review/plan.md',
    '- The ask: /review/ask.md',
    '',
    'Fix the cause, not the check. Checkpoint, then call submit_build_log one time.',
  ].join('\n')
}

/** A red CI as a repair cause: the failed jobs, with the logs in /review/ci-failure.txt. */
function ciCause(ci: Ci): Cause {
  const failed = ci.jobs.filter((job) => !job.ok)
  const at = ci.sha.slice(0, 12)
  return {
    from: 'CI',
    short: `${failed.map((job) => job.name).join(', ')} failed on ${at}`,
    text: [`# CI failed on ${at}`, '', ...failed.map((job) => `- ${job.name}: ${job.url}`), '', 'The logs: /review/ci-failure.txt', ''].join('\n'),
    logs: ci.failures,
  }
}

/** A failed review pass as a repair cause: its failed criteria, with the intent gaps and the refused rejections in their details. */
function reviewCause(pass: number, review: Review): Cause {
  const failed = review.failed ?? []
  return {
    from: `review pass ${pass}`,
    short: failed.length > 0 ? `failed: ${failed.map((criterion) => criterion.name).join(', ')}` : 'FAIL',
    text: [
      `# Review pass ${pass} failed on ${review.final.slice(0, 12)}`,
      '',
      ...(failed.length > 0 ? failed.map((criterion) => `- ${criterion.name}: ${criterion.detail}`) : ['- The record of the pass has no failed criteria.']),
      '',
    ].join('\n'),
    logs: null,
  }
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

/** The PR description shows at most this many words of the smallest change, so that it stays short for any plan. */
const prWords = 140

function closeFence(markdown: string): string {
  let fence = ''
  for (const line of markdown.split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = ''
    } else {
      fence = /^ {0,3}(`{3,}(?!.*`)|~{3,})/.exec(line)?.[1] ?? ''
    }
  }
  return fence ? `${markdown}\n${fence}` : markdown
}

/**
 * The PR description, written by the host (G7). Only `Closes #<issue>` and the smallest change are visible. The frozen
 * package (the run, the ask, the decisions and the plan) is in one collapsed block.
 */
export function prBody(input: DevelopInput, answers: Answer[], planText: string, smallestChange: string): string {
  const trimmed = smallestChange.trim()
  // Cut at the start of the first word over the limit, so that the line breaks of the shown words stay.
  const over = [...trimmed.matchAll(/\S+/g)][prWords]
  const shown = over ? `${trimmed.slice(0, over.index).trimEnd()} …` : trimmed
  return [
    ...(input.issue ? [`Closes #${input.issue}`, ''] : []),
    // Close an open code fence so that GitHub does not show the details block as code.
    closeFence(shown),
    '',
    '<details><summary>Run, ask, decisions and plan</summary>',
    '',
    `agent-factory run \`${input.runId}\` (${input.source}) opened this draft PR. It stays draft until the review loop passes and CI is green.`,
    '',
    '# Ask',
    '',
    ...input.ask.trim().split('\n').map((line) => `> ${line}`),
    '',
    ...decisionLists(answers, { user: '# Decisions of the user', run: '# Decisions the run made' }),
    planText,
    '',
    '</details>',
  ].join('\n')
}

/**
 * Cuts a report to the comment limit. The cut can remove the closing `</details>` tag, so this function closes the block
 * before the note. Thus the note stays visible.
 */
export function cutReport(report: string, note: string): string {
  if (report.length <= commentLimit) return report
  const head = report.slice(0, commentLimit)
  const open = head.lastIndexOf('<details>') > head.lastIndexOf('</details>')
  return `${head}${open ? '\n\n</details>' : ''}\n\n${note}`
}

type ReportState = {
  input: DevelopInput
  intake: Intake | null
  route: Route | null
  plan: Plan | null
  branch: string | null
  signing: SigningRecord | null
  head: string | null
  pr: { number: number; url: string } | null
  built: { task: PlanTask; log: BuildLog }[]
  repairs: Repair[]
  cis: Ci[]
  reviews: Review[]
  /** The review pass that stopped at its budget. Its spend counts until the pass runs again and finishes. */
  stoppedReview: Review | null
}

/** One row of the Usage section for a review pass, with the tokens and USD of all its agents. */
function reviewRow(review: Review, index: number): UsageRow {
  const usage = review.usage ?? { tokens: zeroTokens(), usd: 0, unpriced: [] }
  return { step: `review.${index + 1}`, model: 'review loop', tokens: usage.tokens, usd: usage.usd, unpriced: usage.unpriced }
}

function renderReport(state: ReportState, status: DevelopStatus, criteria: Criterion[], note: string, answers: Answer[], usage: string[], branches: string[], alarms: string[]): string {
  const triage = (report: string) => /^- Triage: (.*)$/m.exec(report)?.[1] ?? ''
  const failed = criteria.filter((criterion) => !criterion.ok)
  const criterionLine = (criterion: Criterion) => `- [${criterion.ok ? 'x' : ' '}] ${criterion.name}: ${criterion.detail}`
  return [
    `# Development run: ${status.toUpperCase()}`,
    '',
    ...(state.pr ? [`PR: ${state.pr.url}`, ''] : []),
    note,
    '',
    ...(failed.length > 0 ? [...failed.map(criterionLine), ''] : []),
    '<details><summary>Run details</summary>',
    '',
    `- Run: ${state.input.runId}`,
    `- Source: ${state.input.source}`,
    ...(state.intake ? [`- Title: ${state.intake.title}`] : []),
    ...(state.route ? [`- Route: ${state.route.spec ? 'spec, then plan' : 'plan'}, ${state.route.passes} review loop ${state.route.passes === 1 ? 'pass' : 'passes'}. ${state.intake?.reason ?? ''}`] : []),
    ...(state.branch ? [`- Branch: ${state.branch}${state.head ? ` at ${state.head.slice(0, 12)}` : ''}`] : []),
    ...(state.signing ? [`- ${signingLine(state.signing)}`] : []),
    ...alarms,
    '',
    ...(criteria.length > 0 ? ['## Criteria', '', ...criteria.map(criterionLine), ''] : []),
    ...(state.plan ? ['## Plan', '', state.plan.smallest_change, ''] : []),
    ...(state.built.length > 0
      ? ['## Tasks', '', ...state.built.map((entry) => `- ${entry.task.id}: ${entry.log.blocked.trim() ? `blocked: ${entry.log.blocked}` : entry.log.summary}`), '']
      : []),
    ...(state.cis.length > 0
      ? [
          '## CI',
          '',
          ...state.cis.map((ci) => `- ${ci.sha.slice(0, 12)}: ${ci.state}${ci.jobs.length ? ` (${ci.jobs.map((job) => `${job.name}=${job.ok ? 'pass' : 'fail'}`).join(', ')})` : ''}`),
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
    ...(state.repairs.length > 0
      ? [
          '## Repair rounds',
          '',
          ...state.repairs.map(
            (repair) => `- Round ${repair.round}, ${repair.cause.from}: ${repair.cause.short}. ${repair.log.blocked.trim() ? `Blocked: ${repair.log.blocked}` : repair.log.summary}`,
          ),
          '',
        ]
      : []),
    ...branches,
    ...usage,
    '',
    ...decisionSections(answers),
    '',
    '</details>',
  ].join('\n')
}
