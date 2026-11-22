import type { Contracts } from 'nanocode-ts'
import type { CiJob } from '../ci.ts'
import type { FailedFinalCheck, MergeMethod, RepoConfig } from '../checks.ts'
import { build, intake, plan, writeSpec, type BuildLog, type DevelopContext } from '../develop-steps.ts'
import { step, type Ledger } from '../ledger.ts'
import { alarmLines, settleAll } from '../planned-stop.ts'
import { frozenAsk, renderPlan, route, routeQuestions, waves, type Intake, type Plan, type PlanTask, type Route } from '../plan.ts'
import type { AgentStore, Branch, Branches, Checker, Files, Guides, MergeRefusal, PullRequests, RerunStart, Signing } from '../platform.ts'
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

/**
 * `budget` is what remains up to twice the development budget, so that the review loop stops where the development gate
 * pauses. `branch` is the PR head branch. `base` is the current merge base of the change (D16). Default: the base of the input.
 */
export type ReviewRequest = { runId: string; ask: string; head: string; branch: string; full: boolean; pr: number; budget?: number; base?: string }

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
const repairRounds = 5
/** Base merges of a run: the checks before ready and before the merge, and the retries after a 'stale' refusal, share them (D16). */
const baseMergeLimit = 3
/** Merge tries of a run. Each try after a 'stale' refusal comes after a base check (D16). */
const mergeTryLimit = 3
/** How long CI can take to start for a push of a commit that already has finished CI. */
const ciGraceMs = 3 * 60_000
/** The most that GitHub's clock and the host's clock can differ. */
const clockSkewMs = 30_000
const defaultParallel = 3

type Ci = { sha: string; state: 'pass' | 'fail' | 'none'; jobs: CiJob[]; failures: string }
/** A review pass. Records of older runs have no usage, which counts as zero, and no failed criteria or failed checks. */
type Review = { pass: boolean; head: string; final: string; branch: string; report: string; usage?: RunUsage; failed?: Criterion[]; failedChecks?: FailedFinalCheck[] }
/**
 * The cause of a repair round. `from` is 'CI' or 'review pass N', `short` is one line for the prompt and the report,
 * `text` is /review/repair.txt, `logs` is /review/ci-failure.txt when CI failed, and `report` is
 * /review/review-report.md when a review pass failed. `checks` is /review/check-failure.txt when final checks of a
 * review pass failed. `conflicts` are the files that conflict in a base merge. `rerunnable` holds the failed checks
 * that a rerun can pass.
 */
type Cause = { from: string; short: string; text: string; logs: string | null; report: string | null; checks: string | null; conflicts?: string[]; rerunnable?: Rerunnable }
/** The failed checks of a cause on the head `head` (D14): a red CI, or the failed final checks of review pass `pass`. */
type Rerunnable = { head: string; ci: Ci } | { head: string; pass: number; review: Review }
/** A rerun of a failed CI job or final check on a head (D14). */
type Rerun = { check: string; head: string; result: 'flaky' | 'failed' | 'refused'; reason?: string }
type Repair = { round: number; cause: Cause; log: BuildLog }
type BasePoint = 'ready' | 'merge'
/** The result of a base merge, and `change`: the paths of the change before it, from the merge base to the head. */
type BaseMerge = { files: string[]; conflicts: string[]; change: string[] }
/** A base check (D16). `merge` is null when the base did not move or the run used its base merges. */
type BaseCheck = { point: BasePoint; base: string; moved: boolean; merge: BaseMerge | null }
/** A merge try as the ledger records it. A refusal of a ledger from before D16 has no kind. */
type RecordedMerge = { merged: true; sha: string } | { merged: false; reason: string; kind?: MergeRefusal }

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
 * parallel when their files do not overlap, each on its own branch), a draft PR, CI, the code review loop, CI again,
 * and a ready PR only when every criterion holds. A red CI or a failed review pass gets a repair round inside one
 * budget, and a new review pass reviews the fixes (D14). Before the ready step and the merge, the host merges a base
 * that moved (D16). Every step is in the ledger, so the same run ID
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
  const state: ReportState = { input, intake: null, route: null, plan: null, branch: null, signing: null, head: null, pr: null, built: [], repairs: [], cis: [], reviews: [], stoppedReview: null, baseMerges: [], mergeTries: [], reruns: [] }
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
  // `point` names the push in the run. A resume gets the head of each push from the ledger, not the local head, which a
  // later base merge moved.
  // A resolved base merge can keep the local head but still need a push to create its merge commit.
  const publish = async (point: string) => {
    const sha = await step(ledger, `head.${point}`, async () => {
      return step(ledger, `push.${point}`, async () => {
        const at = Date.now()
        const pushed = await branches.push(dev)
        ledger.put(`pushed-at:${pushed}`, at)
        return pushed
      })
    })
    state.head = sha
    return sha
  }
  const waitCi = async (name: string, sha: string, after?: Map<number, number>): Promise<Ci> => {
    const result = await watchCi(ledger, pulls, deps.ci, name, sha, after)
    state.cis.push(result)
    return result
  }
  const pushed = await publish('build')
  state.pr = await step(ledger, 'pr', () => pulls.open({ head: branchName, title: intook.title, body: prBody(input, decisions(ledger), planText, planned.smallest_change) }))
  const fixer = planned.tasks.length === 1 ? `build.${planned.tasks[0]!.id}` : 'ci-fix'

  // 4 and 5. Freeze and the review loop. The frozen package is the ask, the decisions and the plan.
  // A pass gets the budget up to twice the run budget and stops there without a question. That stop is not a finished
  // step: the budget gate of this run then asks with the run totals, or raises the budget in a hotfix run.
  // After a raise, or on a resume with a higher budget, the same pass runs again with the new remaining budget.
  const reviewPass = async (pass: number, at: string, base: string): Promise<Review> => {
    const stoppedKey = `review-stopped.${pass}`
    const review = await step(ledger, `review.${pass}`, async (): Promise<Review> => {
      state.stoppedReview = ledger.get<Review>(stoppedKey) ?? null
      for (;;) {
        await budget.check()
        // After the check, the spend is below twice the limit, so the remaining budget is positive. The ledger of the pass
        // already counts the spend of its stopped attempt, so that spend is not taken from the remaining budget.
        const limit = budget.limit()
        const remaining = limit === undefined ? {} : { budget: 2 * limit - budget.spent() + (state.stoppedReview?.usage?.usd ?? 0) }
        const loop = await deps.review({ runId: `${input.runId}-review-${pass}`, ask: frozen, head: at, base, branch: branchName, full: input.full === true, pr: state.pr!.number, ...remaining })
        const failed = loop.criteria.filter((criterion) => !criterion.ok)
        const result: Review = { pass: loop.pass, head: at, final: loop.final, branch: loop.branch, report: loop.report, usage: loop.usage, failed, failedChecks: loop.failedChecks }
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

  // The repair loop (D14, G6). CI failures and failed review passes share one repair budget. CI runs after each round,
  // and no review pass runs while CI is red. Before a round and after a blocked fixer, the failed checks run again one time.
  // The fixes of a repair always go through a new review pass. All control comes from ledger steps, so a resumed run
  // replays the loop and repeats no round.
  // A ledger from before D14 has review passes after its CI-fix rounds. The repair rounds make new commits that those
  // passes did not review.
  if (!ledger.get('repair-workflow')) {
    if (ledger.get('step:ci-fix.1') && ledger.get('step:review.1'))
      return finish('failed', [], 'The review passes of this run are from before D14 and did not review the repair commits. Start a new run. The PR stays draft.')
    // On a resume, this record identifies new review passes as D14 passes.
    ledger.put('repair-workflow', true)
  }
  let head = pushed
  // The CI of the last checked commit. It checks the head only when its sha is the head.
  let ci = await waitCi('ci.build.0', head)
  // Why the head needs a new review pass, or null: a repair or a base merge after the last pass.
  let unreviewed: string | null = null
  // The cause that remains when the budget is used.
  let unrepaired: Cause | null = null
  // The start of the files of the change: the merge base with the base branch, which a base merge moves (D16).
  let mergeBase = input.base
  const taskFiles = [...new Set(planned.tasks.flatMap((task) => task.files))]

  // One round of the repair budget. A base merge with a conflict also gives the fixer the files that conflict.
  const repair = async (cause: Cause, merge?: BaseMerge): Promise<BuildLog> => {
    const round = state.repairs.length + 1
    const log = await step(ledger, `repair.${round}`, () =>
      build(context, {
        id: fixer,
        turn: { request: `repair-${round}`, key: `output:${fixer}:repair-${round}` },
        model: models.builder,
        branch: dev,
        scope: merge ? [...new Set([...taskFiles, ...merge.conflicts])] : taskFiles,
        active,
        checker: deps.checker(dev),
        base: mergeBase,
        ...(merge ? { baseFiles: merge.files.filter((path) => !merge.conflicts.includes(path)) } : {}),
        review: {
          '/ask.md': input.ask,
          '/plan.md': planText,
          '/repair.txt': cause.text,
          ...(cause.logs === null ? {} : { '/ci-failure.txt': cause.logs }),
          ...(cause.checks === null ? {} : { '/check-failure.txt': cause.checks }),
          ...(cause.report === null ? {} : { '/review-report.md': cause.report }),
        },
        prompt: repairPrompt(round, cause),
        label: `agent-factory: repair ${round}`,
      }),
    )
    state.repairs.push({ round, cause, log })
    return log
  }

  // The checks that ran again, as keys of the check and the head: at most one rerun for each (D14). A resumed run
  // replays the same rerun steps in the same order, so it fills the same keys and sends no request again.
  const reran = new Set<string>()
  // A red CI of Actions runs only, without a rerun on its commit: one rerun request for each failed run, then the CI of
  // a newer attempt of each started run. It replaces `ci` and gives true, or gives false when no run started.
  const rerunCi = async (): Promise<boolean> => {
    const sha = ci.sha
    const failed = ci.jobs.filter((job) => !job.ok)
    const runs = failed.flatMap((job) => (job.run === null ? [] : [{ job, run: job.run }]))
    // A failed commit status has no run, so it cannot pass on a rerun.
    if (runs.length < failed.length || runs.some(({ run }) => reran.has(`run ${run}@${sha}`))) return false
    const started: typeof runs = []
    for (const entry of runs) {
      reran.add(`run ${entry.run}@${sha}`)
      // The host records the request before it sends it. After a lost response, a resume reads the attempt of the run
      // and sends no second request.
      const sent = `rerun-sent:${entry.run}@${sha}`
      const start = await step(ledger, `rerun.run.${entry.run}.${sha}`, async (): Promise<RerunStart> => {
        if (!ledger.get(sent)) {
          ledger.put(sent, true)
          return pulls.rerunFailedJobs(entry.run)
        }
        const jobs = await pulls.ci(sha)
        return jobs.some((job) => job.run === entry.run && (job.attempt ?? 1) > (entry.job.attempt ?? 1))
          ? { started: true }
          : { started: false, reason: 'the request got no response, and the run has no new attempt' }
      })
      if (start.started) started.push(entry)
      else state.reruns.push({ check: entry.job.name, head: sha, result: 'refused', reason: start.reason })
    }
    if (started.length === 0) return false
    ci = await waitCi(`ci.rerun.${sha}`, sha, new Map(started.map(({ job, run }) => [run, job.attempt ?? 1])))
    for (const { job, run } of started) state.reruns.push({ check: job.name, head: sha, result: ci.jobs.some((now) => now.run === run && now.ok) ? 'flaky' : 'failed' })
    return true
  }
  // The failed final checks of a review pass without a rerun on `at`: each runs again one time on the development
  // branch. It gives the review without the flaky checks, or null when no check ran again.
  const rerunChecks = async (review: Review, at: string): Promise<Review | null> => {
    const checks = (review.failedChecks ?? []).filter((check) => !reran.has(`check ${check.name}@${at}`))
    const again = deps.checker(dev).rerun
    if (checks.length === 0 || !again) return null
    const flaky: string[] = []
    for (const { name } of checks) {
      reran.add(`check ${name}@${at}`)
      const result = await step(ledger, `rerun.check.${name}.${at}`, async (): Promise<Rerun['result']> => {
        const results = await again(name, await dev.changedFiles(mergeBase, at))
        return results.length > 0 && results.every((result) => result.status !== 'fail') ? 'flaky' : 'failed'
      })
      state.reruns.push({ check: name, head: at, result })
      if (result === 'flaky') flaky.push(name)
    }
    return withoutChecks(review, flaky)
  }
  // After a blocked fixer that left the local head `before` of the round as it was, the failed checks of the cause without
  // a rerun run again one time. It gives undefined when the run ends blocked, null when no cause remains, or the cause
  // without the flaky checks. The step records the state of the head, because a later step can move it before a resume.
  const afterBlock = async (cause: Cause, round: number, before: string): Promise<Cause | null | undefined> => {
    const source = cause.rerunnable
    if (!source) return undefined
    const untouched = await step(ledger, `blocked.${round}`, async () => {
      const pending = await dev.pending()
      return (await dev.head()) === before && pending.changed.length === 0 && pending.removed.length === 0
    })
    if (!untouched) return undefined
    // `ci` is still the CI of the cause, because nothing changed the head.
    if ('ci' in source) return (await rerunCi()) && ci.state === 'pass' ? null : undefined
    const rest = await rerunChecks(source.review, source.head)
    if (!rest || (rest.failedChecks ?? []).length > 0) return undefined
    if (!rest.pass) return reviewCause(source.pass, rest, source.head)
    state.reviews[source.pass - 1] = rest
    return null
  }

  // Runs until CI and the review passes hold on the head, or the budget is used. It returns the end of a blocked run.
  const repairLoop = async (): Promise<DevelopResult | null> => {
    // The cause that a rerun after a blocked fixer leaves for the next round.
    let carried: Cause | null = null
    for (;;) {
      if (ci.state === 'none') return finish('blocked', [], noCi(ci.sha), true)
      let cause: Cause
      if (carried) {
        cause = carried
        carried = null
      } else if (ci.state === 'fail') {
        // The rerun comes before the check of the budget, so a flaky job uses no round.
        if (await rerunCi()) continue
        cause = ciCause(ci)
      } else if (state.reviews.length < routed.passes || state.reviews.at(-1)?.pass !== true || unreviewed !== null) {
        const pass = state.reviews.length + 1
        const review = await reviewPass(pass, head, mergeBase)
        unreviewed = null
        if (review.final !== review.head) {
          await step(ledger, `merge.review.${pass}`, async () => {
            await dev.merge(review.final, `agent-factory: review loop fixes, pass ${pass} (${input.runId})`)
            return dev.head()
          })
          head = await publish(`review.${pass}`)
        }
        if (review.pass) continue
        // When only checks failed, they run again first. When they pass, the pass counts as passed.
        const rest = onlyChecks(review) ? await rerunChecks(review, head) : null
        if (rest?.pass) {
          state.reviews[pass - 1] = rest
          continue
        }
        cause = reviewCause(pass, rest ?? review, head)
      } else if (ci.sha !== head) {
        // 7 and 8. CI on the head after the last PASS.
        ci = await waitCi(`ci.final.${state.reviews.length}`, head)
        continue
      } else return null
      if (state.repairs.length === repairRounds) {
        unrepaired = cause
        return null
      }
      // The local head before the round. On the Worker, the pushed head of the cause is another SHA.
      const before = await step(ledger, `local-head.repair.${state.repairs.length + 1}`, () => dev.head())
      const log = await repair(cause)
      if (log.blocked.trim()) {
        const rest = await afterBlock(cause, state.repairs.length, before)
        if (rest === undefined) return finish('blocked', [], `The repair is blocked: ${log.blocked}`)
        carried = rest
        continue
      }
      head = await publish(`repair.${state.repairs.length}`)
      unreviewed = 'a repair after the last pass'
      ci = await waitCi(`ci.repair.${state.repairs.length}`, head)
    }
  }

  // Hygiene and the criteria of the head.
  const judge = async (): Promise<Criterion[]> => {
    const reviewed = state.reviews.length >= routed.passes && state.reviews.at(-1)?.pass === true && unreviewed === null
    const finalCi = ci.sha === head ? ci : null
    const changed = await dev.changedFiles(mergeBase, head)
    const forbidden = forbiddenPaths(changed, active)
    const solidity = active.find((profile) => profile.id === 'solidity')
    const audit = solidity !== undefined && changed.some((path) => solidity.files.test(path))
    return [
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
          ...(unreviewed === null ? [] : [unreviewed]),
        ].join(', '),
      },
      {
        name: 'CI green on the head',
        ok: finalCi?.state === 'pass',
        detail: finalCi ? `${head.slice(0, 12)}: ${finalCi.jobs.map((job) => `${job.name}=${job.ok ? 'pass' : 'fail'}`).join(', ')}` : 'not checked: the review loop did not pass',
      },
      { name: 'No build output, logs or environment files', ok: forbidden.length === 0, detail: forbidden.join(', ') || 'none in the change' },
      ...(audit ? [{ name: 'Auditor for Solidity src/', ok: false, detail: 'required, not built yet. Audit the change before you merge. The PR stays draft.' }] : []),
    ]
  }
  const passed = (list: Criterion[]) => list.every((criterion) => criterion.ok)
  const used = (cause: Cause) => `the run used its ${repairRounds} repair rounds. The last cause: ${cause.from}, ${cause.short}`

  const looped = await repairLoop()
  if (looped) return looped
  let criteria = await judge()
  // When the budget is used, the run ends failed with the last cause.
  if (!passed(criteria)) return finish('failed', criteria, `${unrepaired ? `${sentence(used(unrepaired))}. ` : ''}The PR stays draft.`)

  // D16. The base checks of the run. Each one is a ledger step with its base merge, so that a resume never merges again.
  // A ledger from before D16 marked the PR ready without a base check, so its resume does not change the reviewed PR.
  const baseChecks = ledger.get('base-merge-workflow') === true || !ledger.get('step:ready')
  if (baseChecks) ledger.put('base-merge-workflow', true)
  let checks = 0
  const checkBase = async (point: BasePoint): Promise<BaseCheck> => {
    checks += 1
    const check = await step(ledger, `base-check.${checks}`, async (): Promise<BaseCheck> => {
      const base = await branches.remoteHead(input.baseRef)
      const moved = (await dev.mergeBaseWith(base)) !== base
      if (!moved || state.baseMerges.length >= baseMergeLimit) return { point, base, moved, merge: null }
      const change = await dev.touchedFiles(mergeBase, await dev.head())
      const merged = await dev.mergeCommit(base, `agent-factory: merge ${input.baseRef} (${input.runId})`)
      return { point, base, moved, merge: { ...merged, change } }
    })
    if (check.merge) state.baseMerges.push(check)
    return check
  }
  // The end of a run whose base merge did not finish: before ready, the run fails with the PR draft. Before the merge,
  // the PR stays ready and the host does not merge.
  const unmerged = (point: BasePoint, shown: Criterion[], reason: string) =>
    point === 'ready' ? finish('failed', shown, `${sentence(reason)}. The PR stays draft.`) : finish('ready', shown, `Not merged: ${reason}. The PR stays ready for your review. You merge.`)
  // Before the merge, an error of the base merge or of its push leaves the PR ready. A pause or a stop stays an error.
  const thrown = (point: BasePoint, error: unknown) => point === 'ready' || error instanceof PausedError || error instanceof BudgetStop || error instanceof StopError

  // Merges the base while it moves, up to the limit of the run. After each merge: a conflict round when needed, the
  // push, CI, the repair loop and the criteria. It returns the end of the run, or null when the run goes on.
  const settle = async (point: BasePoint): Promise<DevelopResult | null> => {
    if (!baseChecks) return null
    for (;;) {
      let check: BaseCheck
      try {
        check = await checkBase(point)
      } catch (error) {
        if (thrown(point, error)) throw error
        return unmerged(point, criteria, `the base merge failed: ${reasonOf(error)}`)
      }
      if (!check.moved) return null
      const merge = check.merge
      // At the limit, the ready step takes the PR as it is. The merge waits for the user.
      if (!merge) return point === 'ready' ? null : unmerged(point, criteria, 'the base keeps moving')
      const n = state.baseMerges.length
      mergeBase = check.base
      // The PR on GitHub is still the head of the passed criteria, so the merge point shows them.
      const shown = point === 'ready' ? [] : criteria
      if (merge.conflicts.length > 0) {
        const cause = mergeCause(check.base, merge.conflicts)
        if (state.repairs.length === repairRounds) {
          unrepaired = cause
          return unmerged(point, shown, used(cause))
        }
        const log = await repair(cause, merge)
        if (log.blocked.trim()) return finish('blocked', [], `The repair is blocked: ${log.blocked}`)
        const marked = await step(ledger, `finish-merge.${n}`, () => dev.finishMerge(merge.conflicts, `agent-factory: merge ${input.baseRef} (${input.runId})`))
        if (marked.length > 0) return unmerged(point, shown, `the conflict markers remain in ${marked.join(', ')}`)
      }
      try {
        head = await publish(`base.${n}`)
      } catch (error) {
        if (thrown(point, error)) throw error
        return unmerged(point, criteria, `the push of the base merge failed: ${reasonOf(error)}`)
      }
      if (merge.conflicts.length > 0 || merge.files.some((path) => merge.change.includes(path))) unreviewed = 'a base merge after the last pass'
      ci = await waitCi(`ci.base.${n}`, head)
      const ended = await repairLoop()
      if (ended) return ended
      criteria = await judge()
      if (!passed(criteria)) return unmerged(point, criteria, unrepaired ? used(unrepaired) : 'a criterion failed after the base merge')
    }
  }

  const beforeReady = await settle('ready')
  if (beforeReady) return beforeReady
  const pr = state.pr!.number
  await step(ledger, 'ready', async () => (await pulls.ready(pr), true))
  const method = input.config.merge
  if (!method) return finish('ready', criteria, 'Ready for your review. You merge.')

  // 9. The merge, only with the standing permission and only at the head that the final CI checked. Each try is a step
  // that records a refusal as a result, so that a resumed run never tries it again. The first keeps the step name of
  // older ledgers. A 'stale' refusal gets a base check and another try (D16). A recorded refusal without a kind is 'other'.
  for (let attempt = 1; ; attempt++) {
    const beforeMerge = await settle('merge')
    if (beforeMerge) return beforeMerge
    const merged = await step(ledger, attempt === 1 ? 'merge' : `merge.${attempt}`, async (): Promise<RecordedMerge> => {
      try {
        return await pulls.merge(pr, { method, sha: head })
      } catch (error) {
        return { merged: false, reason: reasonOf(error), kind: 'other' }
      }
    })
    state.mergeTries.push(merged)
    if (!merged.merged) {
      if ((merged.kind ?? 'other') === 'stale' && attempt < mergeTryLimit) continue
      return finish('ready', criteria, `Not merged: ${merged.reason}. The PR stays ready for your review. You merge.`)
    }
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
}

/**
 * Waits for the CI of a commit. A commit can already have CI from another branch, for example the review loop's
 * branch, while the runs of the push to the run's branch and of the PR have not started yet. So the host waits for
 * a job that started after the push, and takes the older jobs alone only after a grace period. A result without CI
 * is not recorded, so a resumed run looks again. After a rerun, `after` gives the failed attempt of each run that ran
 * again, and only a newer attempt of each counts. The push does not apply then.
 */
async function watchCi(ledger: Ledger, pulls: PullRequests, timing: DevelopDeps['ci'], name: string, sha: string, after?: Map<number, number>): Promise<Ci> {
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
    const ready = after
      ? [...after].every(([run, attempt]) => jobs.some((job) => job.run === run && (job.attempt ?? 1) > attempt))
      : fresh || Date.now() - pushedAt >= ciGraceMs
    if (jobs.length > 0 && jobs.every((job) => job.done) && ready) {
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
    ...(cause.conflicts ? [`- The files that conflict: ${cause.conflicts.join(', ')}. The merge of the base is in progress in /repo.`] : []),
    ...(cause.logs === null ? [] : ['- The CI logs: /review/ci-failure.txt']),
    ...(cause.checks === null ? [] : ['- The output of the failed checks: /review/check-failure.txt']),
    ...(cause.report === null ? [] : ['- The report of the review pass, with the findings that the patch agents skipped: /review/review-report.md']),
    '- The plan: /review/plan.md',
    '- The ask: /review/ask.md',
    '',
    cause.conflicts
      ? 'Keep the changes of both sides in each file that conflicts, and remove the conflict markers. Checkpoint, then call submit_build_log one time.'
      : 'Fix the cause, not the check. Checkpoint, then call submit_build_log one time.',
  ].join('\n')
}

/** A base merge with conflicts as a repair cause (D16). The files that conflict have conflict markers in the tree. */
function mergeCause(base: string, conflicts: string[]): Cause {
  const at = base.slice(0, 12)
  return {
    from: 'base merge',
    short: `${at} conflicts in ${conflicts.join(', ')}`,
    text: [`# The merge of the base ${at} has conflicts`, '', ...conflicts.map((path) => `- ${path}`), '', 'The merge is in progress. Your checkpoint commits it.', ''].join('\n'),
    logs: null,
    report: null,
    checks: null,
    conflicts,
  }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A red CI as a repair cause: the failed jobs, with the logs in /review/ci-failure.txt. */
function ciCause(ci: Ci): Cause {
  const failed = ci.jobs.filter((job) => !job.ok)
  const at = ci.sha.slice(0, 12)
  return {
    from: 'CI',
    short: `${failed.map((job) => job.name).join(', ')} failed on ${at}`,
    text: [`# CI failed on ${at}`, '', ...failed.map((job) => `- ${job.name}: ${job.url}`), '', 'The logs: /review/ci-failure.txt', ''].join('\n'),
    logs: ci.failures,
    report: null,
    checks: null,
    rerunnable: { head: ci.sha, ci },
  }
}

/**
 * A failed review pass as a repair cause: its failed criteria, with the intent gaps and the refused rejections in their
 * details. The report of the pass gives the skipped findings with their reasons and the checks. Each failed final check
 * goes to /review/check-failure.txt with its command and the end of its output. `head` is the head of the checks.
 */
function reviewCause(pass: number, review: Review, head: string): Cause {
  const failed = review.failed ?? []
  const checks = review.failedChecks ?? []
  return {
    from: `review pass ${pass}`,
    short: failed.length > 0 ? `failed: ${failed.map((criterion) => criterion.name).join(', ')}` : 'FAIL',
    text: [
      `# Review pass ${pass} failed on ${review.final.slice(0, 12)}`,
      '',
      ...(failed.length > 0 ? failed.map((criterion) => `- ${criterion.name}: ${criterion.detail}`) : ['- The record of the pass has no failed criteria.']),
      '',
      ...(checks.length > 0 ? ['The output of the failed checks: /review/check-failure.txt', ''] : []),
    ].join('\n'),
    logs: null,
    report: review.report,
    checks: checks.length > 0 ? checks.map((check) => `--- ${check.name}: ${check.command} ---\n${check.output}\n`).join('\n') : null,
    rerunnable: { head, pass, review },
  }
}

/** The name of the criterion of the final checks in the review loop. */
const checksGreen = 'Checks green'

/** True when the final checks are the only failed criterion of a review pass. */
const onlyChecks = (review: Review) => (review.failed ?? []).length > 0 && (review.failed ?? []).every((criterion) => criterion.name === checksGreen)

/** A review pass without the `flaky` checks. When no failed criterion remains, the pass counts as passed (D14). */
function withoutChecks(review: Review, flaky: string[]): Review {
  const checks = (review.failedChecks ?? []).filter((check) => !flaky.includes(check.name))
  const failed = (review.failed ?? []).flatMap((criterion) =>
    criterion.name !== checksGreen ? [criterion] : checks.length > 0 ? [{ ...criterion, detail: `failed: ${checks.map((check) => check.name).join(', ')}` }] : [],
  )
  // A record of an older run has no failed criteria, so it never counts as passed here.
  return { ...review, pass: review.failed !== undefined && failed.length === 0, failed, failedChecks: checks }
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
  baseMerges: BaseCheck[]
  mergeTries: RecordedMerge[]
  reruns: Rerun[]
}

/** One row of the Usage section for a review pass, with the tokens and USD of all its agents. */
function reviewRow(review: Review, index: number): UsageRow {
  const usage = review.usage ?? { tokens: zeroTokens(), usd: 0, unpriced: [] }
  return { step: `review.${index + 1}`, model: 'review loop', tokens: usage.tokens, usd: usage.usd, unpriced: usage.unpriced }
}

const rerunResults: Record<Rerun['result'], string> = { flaky: 'flaky', failed: 'failed again', refused: 'refused by GitHub' }

function rerunLine(rerun: Rerun): string {
  return `- ${rerun.check} on ${rerun.head.slice(0, 12)}: ${rerunResults[rerun.result]}${rerun.reason ? ` (${rerun.reason})` : ''}`
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
    ...(state.reruns.length > 0 ? ['## Reruns', '', ...state.reruns.map(rerunLine), ''] : []),
    ...(state.baseMerges.length > 0
      ? [
          '## Base merges',
          '',
          ...state.baseMerges.map(
            ({ point, base, merge }) =>
              `- Before ${point === 'ready' ? 'ready' : 'the merge'}: ${base.slice(0, 12)}, ${merge?.conflicts.length ? `conflict in ${merge.conflicts.join(', ')}` : 'clean'}. Files: ${merge?.files.join(', ') || 'none'}`,
          ),
          '',
        ]
      : []),
    ...(state.mergeTries.length > 0
      ? [
          '## Merge tries',
          '',
          ...state.mergeTries.map((merge, index) => `- Try ${index + 1}: ${merge.merged ? `merged as ${merge.sha}` : `refused (${merge.kind ?? 'other'}): ${merge.reason}`}`),
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
