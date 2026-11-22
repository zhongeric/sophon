import type { Contracts } from 'nanocode-ts'
import { artifactId } from '../artifacts.ts'
import type { Machine, RepoConfig } from '../checks.ts'
import { mergeHypotheses, type Dossier, type NumberedHypothesis, type Objection } from '../claims.ts'
import type { BuildLog } from '../develop-steps.ts'
import { checkEgress, type EgressHost } from '../egress.ts'
import {
  defaultUnitParallel,
  runUnits,
  treeInputs,
  unitConflicts,
  unitInputs,
  unitKey,
  unitsDir,
  unitsFiles,
  holdoutRefusal,
  type InputFile,
  type ScanBoxes,
  type UnitConflict,
} from '../fanout.ts'
import { step, type Ledger } from '../ledger.ts'
import { route, routeQuestions } from '../plan.ts'
import { PlannedStop } from '../planned-stop.ts'
import type { AgentStore, Branch, Branches, Checker, Files, Guides, PullRequests } from '../platform.ts'
import { pool } from '../pool.ts'
import { freezePrereg, type Prereg } from '../prereg.ts'
import { presentProfiles, profilesById, type Profile } from '../profiles.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, decisionLists, decisions, type Answer, type Channel, type Question } from '../questions.ts'
import {
  analysisVerdict,
  calibrationVerdict,
  compareReproduction,
  needsRecalibration,
  preregThreshold,
  runDomainCommand,
  runFetch,
  runMerge,
  runPlan,
  type DomainOutputs,
  type DomainRun,
  type HashMismatch,
  type PlanUnit,
} from '../research-commands.ts'
import {
  analyst,
  buildAnalysis,
  conceded,
  generate,
  lateSkeptic,
  numberObjections,
  preregister,
  renderDossier,
  researchEgress,
  researchIntake,
  responseLine,
  skeptic,
  survey,
  writeDossier,
  type BuildFailure,
  type CalibrationSummary,
  type HeldAnswer,
  type LensSurvey,
  type ResearchContext,
  type ResearchIntake,
  type VetRound,
} from '../research-steps.ts'
import { fansOut, type ResearchDomain } from '../research.ts'
import type { ModelChoice } from '../roles.ts'
import { StopError } from '../stop.ts'
import {
  BudgetStop,
  belowBudget,
  budgetGate,
  checkContainerPriced,
  checkPriced,
  clearBudget,
  computeCost,
  computeOf,
  finishCompute,
  formatUsd,
  parseBudget,
  resolveBudget,
  startCompute,
  usageOf,
  usageSection,
  type ContainerPrices,
  type InstanceSpec,
  type Prices,
  type RunUsage,
  type UsageRow,
} from '../usage.ts'
import {
  checkAllowedModels,
  checkFamilySwap,
  decisionSections,
  defaultAllowedModels,
  defaultModels,
  loopModelIds,
  providersOf,
  type LoopModels,
  type LoopResult,
} from './code-review-loop.ts'
import { cutReport, type ReviewRequest } from './develop.ts'

/** The two generators run on two model families, and so do the skeptic and the late skeptic. `review` is the code review loop of the analysis. */
export type ResearchModels = {
  intake: ModelChoice
  surveyor: ModelChoice
  generators: [ModelChoice, ModelChoice]
  preregistrar: ModelChoice
  builder: ModelChoice
  skeptic: ModelChoice
  lateSkeptic: ModelChoice
  analyst: ModelChoice
  writer: ModelChoice
  review: LoopModels
}

const opus: ModelChoice = { provider: 'claude', model: 'claude-opus-5-5' }
const sol: ModelChoice = { provider: 'codex', model: 'gpt-6.1-sol' }

export const defaultResearchModels: ResearchModels = {
  intake: opus,
  surveyor: opus,
  generators: [opus, sol],
  preregistrar: opus,
  builder: opus,
  skeptic: opus,
  lateSkeptic: sol,
  analyst: opus,
  writer: opus,
  review: defaultModels,
}

export type ResearchInput = {
  runId: string
  /** The program, verbatim. */
  program: string
  /** The base commit of the notebook, and its branch. */
  base: string
  baseRef: string
  /** What is researched, for the report, for example a path and a branch. */
  source: string
  models: ResearchModels
  /** The models that the run accepts. Default: defaultAllowedModels. */
  allowedModels?: string[]
  /** At most this many surveyors or preregistrars (default 3), and units of a fan-out (default 32), at the same time. */
  parallel?: number
  /** The cost budget in USD before the intake. The cap that the user gives at intake replaces it. */
  budget?: number
  /** A budget of the current invocation, for example --budget on a resume. It replaces the budget, and the ledger does not record it. The intake cap replaces it. */
  budgetOverride?: number
}

/** What the platform supplies. The domain comes from the base commit. The egress host has the artifacts, the holdout lock and the secrets. */
export type ResearchDeps = {
  module: WebAssembly.Module
  ledger: Ledger
  files: Files
  store: AgentStore
  guides: Guides
  credentials: Credentials
  dispatch?: Contracts.RuntimeOptions['dispatch']
  /** USD per million tokens of each model, from MODEL_PRICES. Default: no prices. */
  prices?: Prices
  channel: Channel
  /** The branches of the notebook. The run commits on a branch of its own, and pushes it only after the reproduction. */
  branches: Branches
  /** The notebook config at the base commit. */
  config: RepoConfig
  pulls: PullRequests
  /** The checks and tests of a branch, run in its worktree. */
  checker(branch: Branch): Checker
  /**
   * A machine on a new checkout of a commit, outside every branch worktree, for the calibration and the reproduction.
   * `key` names the step. A platform that resumes a step in a later call can give the same checkout for the same key.
   * The platform writes `files` into the new checkout, for example the units directory of merge.
   */
  cleanBox(commit: string, key: string, files?: InputFile[]): Promise<ResearchBox>
  /** Runs the code review loop on a commit of the run branch. */
  review(request: ReviewRequest): Promise<LoopResult>
  domain: ResearchDomain
  egress: EgressHost
  /** The boxes of the units of a fan-out config. A fan-out config without them stops the run. */
  scanBoxes?: ScanBoxes
  /** USD per vCPU second and GiB second, from CONTAINER_PRICES. */
  containerPrices?: ContainerPrices
  /** With it, the run meters each domain command on a run box of this instance (null: the local machine). */
  compute?: { runBox: InstanceSpec | null }
  log(line: string): void
}

/** A clean checkout with read access to its output files. Its ID stays the same only when the checkout stays. */
type ResearchBox = Machine & { id: string; read(path: string): Promise<Uint8Array> }

/** A frozen prereg as the ledger records it. */
export type Freeze = { hypothesis: string; version: number; path: string; sha256: string; commit: string }

export type ResearchStatus = 'ready' | 'blocked' | 'failed' | 'stopped'
export type ResearchResult = { status: ResearchStatus; branch: string | null; frozen: Freeze[]; pr: { number: number; url: string } | null; report: string }

const defaultParallel = 3
/** The cap that the intake question recommends when the run has no budget. */
const defaultCap = 25
const noCap = 'No cap'
const noneOption = 'None'
const approveOptions = ['Approve and freeze', 'Reject (write the reason)', 'Drop the hypothesis']
const heldOptions = ['Accept and continue', 'Stop the run']
const lockLines = ['- The lock binds the agents only, not the commands of a box (RG1).', '- The lock does not bind web search, because web search runs at the provider (RG10).']
const frozenKey = 'frozen'
/** The cap of the intake answer, after the host applied it. Null is no cap. */
const capKey = 'cap'
type Cap = { usd: number | null }
type Parsed<T> = { value: T } | { error: string }

const choices = (models: ResearchModels) => [
  models.intake,
  models.surveyor,
  ...models.generators,
  models.preregistrar,
  models.builder,
  models.skeptic,
  models.lateSkeptic,
  models.analyst,
  models.writer,
]

/** Every model of the run, also of the review loop roles that do not run, because a budget needs a price for each. */
const researchModelIds = (models: ResearchModels): string[] => [...choices(models).map((choice) => choice.model), ...loopModelIds(models.review)]

export const researchProviders = (models: ResearchModels): Set<Provider> =>
  new Set([...choices(models).map((choice) => choice.provider), ...providersOf(models.review)])

function checkResearchModels(models: ResearchModels, allowed = defaultAllowedModels): void {
  const refused = [...new Set(choices(models).map((choice) => choice.model))].filter((model) => !allowed.includes(model))
  if (refused.length > 0) throw new StopError(`models outside the allowed list (${allowed.join(', ')}): ${refused.join(', ')}`)
  // A models file can give another count, so the host also checks the count at run time.
  const generators: ModelChoice[] = models.generators
  if (generators.length !== 2) throw new StopError(`the research run needs exactly two generators, not ${generators.length}`)
  if (generators[0]!.provider === generators[1]!.provider) throw new StopError(`the two generators must use two model families, but both use ${generators[0]!.provider}`)
  if (models.skeptic.provider === models.lateSkeptic.provider)
    throw new StopError(`the skeptic and the late skeptic must use two model families, but both use ${models.skeptic.provider}`)
  checkAllowedModels(models.review, allowed)
  checkFamilySwap(models.review)
}

/**
 * The host freezes and commits a prereg only after the user approves it. Then each frozen prereg goes through the
 * analysis, the calibration and the vet by itself (stages 5 to 9). Stage 11 writes the dossiers, reproduces the outputs
 * on a clean checkout, and only then pushes the branch and opens the dossier PR with one review loop pass. Every step is
 * in the ledger, so the same run ID resumes without repeating finished steps.
 */
export async function research(input: ResearchInput, deps: ResearchDeps): Promise<ResearchResult> {
  const stop: { finish?: Finish } = {}
  try {
    return await researchSteps(input, deps, stop)
  } catch (error) {
    if (error instanceof BudgetStop && stop.finish) return stop.finish('stopped', `The run ${error.message}. Reason: cost budget. A PR of the run stays draft.`)
    throw error
  }
}

type Finish = (status: ResearchStatus, note: string) => Promise<ResearchResult>

type ReportState = {
  input: ResearchInput
  intake: ResearchIntake | null
  surveys: LensSurvey[]
  hypotheses: NumberedHypothesis[]
  picked: string[] | null
  branch: string | null
  frozen: Freeze[]
  /** The picked hypotheses that the user dropped at the approval. They get no freeze. */
  dropped: string[]
  analyses: Analysis[]
  /** The head that the run pushed last, or null before the push. */
  pushed: string | null
  pr: { number: number; url: string } | null
  reviews: Review[]
  /** The review pass that stopped at its budget. Its spend counts until the pass runs again and finishes. */
  stoppedReview: Review | null
}

/**
 * The fan-out of one calibration round. `plan` and `fetch` hold artifact IDs for command output and data files.
 * `conflicts` holds each second result of a unit of the round.
 */
type FanOutRound = {
  plan: string
  fetch: string[]
  units: { id: string; status: 'done' | 'failed'; attempts: number; reason?: string }[]
  failed: string[]
  retries: number
  conflicts: UnitConflict[]
}

/**
 * One calibration round on a clean checkout. `known` and `inject` hold artifact IDs for command output and declared files.
 * `reads` holds the reads lists of known and inject, each null when the command did not give one. `fanout` is set
 * only for a fan-out config.
 */
type CalibrationRound = {
  round: number
  head: string
  recall: number | null
  threshold: number
  known: string[]
  inject: string[]
  outputs: DomainOutputs
  reads: { known: string[] | null; inject: string[] | null }
  pass: boolean
  reason: string
  tail: string
  fanout?: FanOutRound
}

/** The ledger record of the last plan, for the cost cap question of a later intake. */
type PlanRecord = { commit: string; hypothesis: string; round: number; units: number; seconds: number }
const planKey = 'plan'

/** One analyze run on a clean checkout of `head`. `command` is the artifact ID of its output, `files` of each declared output file. */
type AnalysisRun = { round: number; head: string; pass: boolean; outputs: DomainOutputs; command: string; files: string[]; reason: string; tail: string }

/** One reproduce run of one prereg on a clean checkout of `head`. `artifact` is the artifact ID of its output. */
type Reproduction = { head: string; pass: boolean; mismatches: HashMismatch[]; missing: string[]; reason: string; artifact: string }

/** What the stages after the freeze record of one frozen prereg, for the next stages and the report. */
type Analysis = {
  freeze: Freeze
  builds: BuildLog[]
  calibrations: CalibrationRound[]
  runs: AnalysisRun[]
  rounds: VetRound[]
  answers: HeldAnswer[]
  dossier: Dossier | null
  reproductions: Reproduction[]
}

/** A review pass. Its usage counts as extra spend of the run. */
type Review = { pass: boolean; head: string; final: string; branch: string; report: string; usage: RunUsage }

type Pending = { hypothesis: NumberedHypothesis; revision?: { round: number; reason: string } }

async function researchSteps(input: ResearchInput, deps: ResearchDeps, stop: { finish?: Finish }): Promise<ResearchResult> {
  const { ledger, domain } = deps
  const { models } = input
  checkResearchModels(models, input.allowedModels)
  const missing = [...researchProviders(models)].filter((provider) => !deps.credentials[provider])
  if (missing.length > 0) throw new StopError(`no credential for ${missing.join(', ')}`)
  try {
    checkEgress(researchEgress(domain), deps.egress)
  } catch (error) {
    throw new StopError(error instanceof Error ? error.message : String(error))
  }
  const fanOut = fansOut(domain.config)
  if (fanOut && !deps.scanBoxes) throw new StopError('the research config has plan, fetch, unit and merge, but this platform gives no scan boxes for the units')
  const prices = deps.prices ?? {}
  // After the intake, the recorded budget is the cap, so that a resume keeps the cap or a later raise.
  const capped = ledger.get<Cap>(capKey)
  const recordedBudget = capped ? (capped.usd ?? undefined) : input.budget
  const checkPrices = () => {
    checkPriced(researchModelIds(models), prices)
    if (fanOut) checkContainerPriced(deps.containerPrices)
  }
  if (resolveBudget(ledger, recordedBudget, input.budgetOverride) !== undefined) checkPrices()
  const state: ReportState = {
    input,
    intake: null,
    surveys: [],
    hypotheses: [],
    picked: null,
    branch: null,
    frozen: [],
    dropped: [],
    analyses: [],
    pushed: null,
    pr: null,
    reviews: [],
    stoppedReview: null,
  }
  const spentPasses = () => [...state.reviews, ...(state.stoppedReview ? [state.stoppedReview] : [])]
  // The standing answers of the notebook take every recommendation (D11).
  const recommend = deps.config.questions === 'recommended'
  // The review pass keeps its usage in its own ledger, so its rows count here as extra rows.
  const budget = budgetGate({
    channel: deps.channel,
    containerPrices: deps.containerPrices,
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
  const context: ResearchContext = {
    host: {
      module: deps.module,
      store: deps.store,
      ledger,
      credentials: deps.credentials,
      dispatch: deps.dispatch,
      egress: deps.egress,
      log: deps.log,
      beforeTurn: budget.check,
    },
    guides: deps.guides,
    domain,
    program: input.program,
    tree: await deps.branches.view(input.base),
  }
  const questions = asker(ledger, deps.channel, input.runId, deps.log, { recommend })
  const ask = async (batch: string, list: Question[]): Promise<Answer[]> => {
    await questions.post(batch, list)
    return questions.wait(batch)
  }
  // The ledger keeps an answer that does not parse, so the question goes again in a new batch.
  const askUntil = async <T>(batch: string, question: Question, answer: string, parse: (text: string) => Parsed<T>): Promise<T> => {
    for (let round = 2; ; round++) {
      const parsed = parse(answer)
      if ('value' in parsed) return parsed.value
      // Asking again would give the same recommendation.
      if (recommend) throw new StopError(`the recommendation of ${batch} is not a valid answer: ${parsed.error}`)
      deps.log(`the answer ${JSON.stringify(answer)} (${batch}): ${parsed.error}, asking again`)
      const [again] = await ask(`${batch}.${round}`, [{ ...question, id: 'Q1', why: `${parsed.error}.\n${question.why}` }])
      answer = again?.answer ?? ''
    }
  }
  const finish: Finish = async (status, note) => {
    const limit = budget.limit()
    const spent = limit === undefined ? undefined : { limit, spent: budget.spent() }
    const usage = usageSection([...usageOf(ledger).agents, ...spentPasses().map(reviewRow)], prices, spent, { rows: computeOf(ledger), prices: deps.containerPrices })
    const report = renderReport(state, status, note, decisions(ledger), usage)
    deps.files.write('report.md', report)
    // A resumed run can end with another result. The PR then gets the new report, but never the same report again.
    if (state.pr && ledger.get('commented') !== report) {
      await deps.pulls.comment(state.pr.number, cutReport(report, `(cut: see report.md of run ${input.runId})`))
      ledger.put('commented', report)
    }
    ledger.put('result', { status, branch: state.branch, frozen: state.frozen, pr: state.pr })
    return { status, branch: state.branch, frozen: state.frozen, pr: state.pr, report }
  }
  stop.finish = finish

  const branchName = `factory/research-${input.runId}`
  const openBranch = () => {
    state.branch = branchName
    return deps.branches.branch(branchName, input.base)
  }
  // A frozen prereg never changes. Each run compares the files on the run branch with the hashes in the ledger.
  state.frozen = ledger.get<Freeze[]>(frozenKey) ?? []
  if (state.frozen.length > 0) await checkFrozen(await openBranch(), state.frozen)

  // 0. Intake: no survey before the user confirms the program and sets the cost cap.
  const intook = await step(ledger, 'intake', () => researchIntake(context, 'intake', models.intake))
  state.intake = intook
  // Without a price for each model, and for a fan-out config also CONTAINER_PRICES, a cap cannot work, so the question recommends no cap.
  const modelsPriced = researchModelIds(models).every((model) => model in prices)
  const notes = [
    ...(modelsPriced ? [] : ['MODEL_PRICES has no price for some models of this run, and a cap needs a price for each model.']),
    ...(fanOut && !deps.containerPrices ? ['CONTAINER_PRICES is not set, and a cap with a fan-out config needs it.'] : []),
    ...(fanOut ? [planNote(ledger.get<PlanRecord>(planKey), deps)] : []),
  ]
  const priced = modelsPriced && (!fanOut || deps.containerPrices !== undefined)
  const [confirm, capAsk] = hostQuestions(intook, priced ? (budget.limit() ?? defaultCap) : undefined, notes)
  const answers = await ask('intake', [...intook.questions, confirm, capAsk])
  if (route(asDevelopIntake(intook), answers).stop) return finish('stopped', 'You stopped the run at intake.')
  if (!capped) {
    const first = answers.find((answer) => answer.id === capAsk.id)?.answer ?? noCap
    const cap = await askUntil('cap', capAsk, first, (text) => parseCap(text, checkPrices))
    applyCap(ledger, cap)
    ledger.put(capKey, { usd: cap ?? null } satisfies Cap)
  }

  // 1. Survey: one surveyor for each lens.
  const parallel = input.parallel ?? defaultParallel
  state.surveys = await pool(domain.config.lenses.survey, parallel, (lens, index) => {
    const id = `survey.${index + 1}`
    return step(ledger, id, () => survey(context, id, models.surveyor, lens))
  })

  // 2. Generate: two generators on two model families, each with all the surveys. Then the host merges their lists.
  const lists = await Promise.all(
    models.generators.map((model, index) => {
      const id = `generate.${index + 1}`
      return step(ledger, id, () => generate(context, id, model, state.surveys))
    }),
  )
  state.hypotheses = await step(ledger, 'merge', async () => mergeHypotheses(lists.map((list) => list.hypotheses)))
  if (state.hypotheses.length === 0) return finish('stopped', 'The generators made no hypothesis, so the run asked no pick question.')

  // 3. Pick: no later agent reads a hypothesis that the user did not pick.
  const picked = await step(ledger, 'picked', async () => {
    const question = pickQuestion(state.hypotheses)
    const [pick] = await ask('pick', [question])
    return askUntil('pick', question, pick?.answer ?? noneOption, (text) => parsePicks(text, state.hypotheses))
  })
  state.picked = picked
  if (picked.length === 0) return finish('stopped', 'You picked no hypothesis, so the run stopped after stage 3.')

  // 4. Preregister: one offline preregistrar for each pick. A rejected prereg goes back to its agent with the reason.
  const branch = await openBranch()
  let pending: Pending[] = state.hypotheses.filter((hypothesis) => picked.includes(hypothesis.id)).map((hypothesis) => ({ hypothesis }))
  for (let round = 1; pending.length > 0; round++) {
    const drafts = await pool(pending, parallel, (item) =>
      step(ledger, `prereg.${item.hypothesis.id}.${round}`, () => preregister(context, models.preregistrar, item.hypothesis, state.surveys, item.revision)),
    )
    const approvals = await ask(`approve.${round}`, drafts.map(approveQuestion))
    const rejected: Pending[] = []
    for (const [index, draft] of drafts.entries()) {
      const answer = approvals[index]?.answer ?? ''
      if (drops(answer)) {
        state.dropped.push(pending[index]!.hypothesis.id)
        continue
      }
      if (!approves(answer)) {
        rejected.push({ hypothesis: pending[index]!.hypothesis, revision: { round, reason: answer === approveOptions[1] ? 'The user gave no reason.' : answer } })
        continue
      }
      const frozen = await step(ledger, `freeze.${draft.hypothesis}`, () => freeze(branch, draft, input.runId, context.tree))
      const list = ledger.get<Freeze[]>(frozenKey) ?? []
      if (!list.some((entry) => entry.path === frozen.path)) ledger.put(frozenKey, [...list, frozen])
      if (!state.frozen.some((entry) => entry.path === frozen.path)) state.frozen.push(frozen)
    }
    pending = rejected
  }
  if (state.frozen.length === 0) return finish('stopped', 'You dropped each picked hypothesis, so the run froze no prereg.')

  // 5 to 9: each frozen prereg by itself, in freeze order (decision 1).
  const active = profilesById(await step(ledger, 'profiles', async () => (await presentProfiles(async (path) => (await context.tree.stat(`/${path}`)) !== null)).map((profile) => profile.id)))
  const stages: Stages = { input, deps, context, branch, active, parallel, ask, askUntil }
  for (const freeze of state.frozen) {
    const analysis: Analysis = { freeze, builds: [], calibrations: [], runs: [], rounds: [], answers: [], dossier: null, reproductions: [] }
    state.analyses.push(analysis)
    const end = await analyze(stages, analysis)
    if (end) return finish(end.status, end.note)
  }

  // 11. The dossiers. The frozen preregs must not change before a dossier cites them.
  await checkFrozen(branch, state.frozen)
  for (const analysis of state.analyses) {
    const { hypothesis } = analysis.freeze
    const task = { ...vetTask(branch, analysis), rounds: analysis.rounds, answers: analysis.answers }
    const dossier = await step(ledger, `writer.${hypothesis}`, () => writeDossier(context, models.writer, task))
    analysis.dossier = dossier
    try {
      await step(ledger, `dossier.${hypothesis}`, async () => {
        const outside = await outsidePaths(branch, (path) => path === `dossier/${hypothesis}.md`)
        if (outside.length > 0) throw new AnalysisScopeError(`Before the dossier of ${hypothesis}, the run branch has uncommitted changes: ${outside.join(', ')}. ${notPushed}`)
        await branch.tree.mkdir('/dossier')
        await branch.tree.write(`/dossier/${hypothesis}.md`, new TextEncoder().encode(renderDossier(hypothesis, dossier, analysis.rounds, analysis.answers, finalAnalysis(analysis).outputs)))
        await branch.commit(`agent-factory: dossier ${hypothesis} (${input.runId})`)
        return branch.head()
      })
    } catch (error) {
      if (error instanceof AnalysisScopeError) return finish('blocked', error.message)
      throw error
    }
  }
  const head = await branch.head()
  if (!(await reproduce(stages, state.analyses, head))) return finish('blocked', `The reproduction on a clean checkout of ${head.slice(0, 12)} failed, so the run did not push the branch and opened no PR.`)

  // The push, the draft PR and one review loop pass on the analysis code.
  const publish = async () => {
    const local = await branch.head()
    state.pushed = await step(ledger, `push.${local}`, () => deps.branches.push(branch))
    return state.pushed
  }
  const at = await publish()
  state.pr = await step(ledger, 'pr', () => deps.pulls.open({ head: branchName, title: intook.title, body: prBody(input, state.analyses, decisions(ledger)) }))
  const pr = state.pr.number
  // A pass that stops at its budget is not a finished step: the budget gate of this run asks with the run totals.
  // After a raise, or on a resume with a higher budget, the same pass runs again with the new remaining budget.
  const stoppedKey = 'review-stopped.1'
  const review = await step(ledger, 'review.1', async (): Promise<Review> => {
    state.stoppedReview = ledger.get<Review>(stoppedKey) ?? null
    for (;;) {
      await budget.check()
      // After the check, the spend is below twice the limit, where the gate pauses (#60), so the remaining budget is
      // positive. The ledger of the pass already counts the spend of its stopped attempt, so that spend is not taken from it.
      const limit = budget.limit()
      const remaining = limit === undefined ? {} : { budget: 2 * limit - budget.spent() + (state.stoppedReview?.usage.usd ?? 0) }
      const loop = await deps.review({ runId: `${input.runId}-review-1`, ask: reviewAsk(input, state.analyses), head: at, branch: branchName, full: false, pr, ...remaining })
      const result: Review = { pass: loop.pass, head: at, final: loop.final, branch: loop.branch, report: loop.report, usage: loop.usage }
      if (!loop.stopped) return result
      ledger.put(stoppedKey, result)
      state.stoppedReview = result
      // Below the run budget, no raise can let the pass go on, for example when the user stopped the pass itself.
      if (limit === undefined || belowBudget(budget.spent(), limit)) throw new BudgetStop('stopped at the cost budget in the review loop pass')
    }
  })
  state.stoppedReview = null
  state.reviews.push(review)
  if (review.final !== review.head) {
    // The review can fix only the analysis code. prereg/ and dossier/ are host files, and the notebook outside analysis/ is the user's.
    const outside = (await branch.changedFiles(review.head, review.final)).filter((path) => !path.startsWith('analysis/'))
    if (outside.length > 0)
      return finish('failed', `The review loop changed paths outside analysis/: ${outside.join(', ')}. The run did not merge its fixes, and the PR stays draft.`)
    await step(ledger, 'merge.review.1', async () => {
      await branch.merge(review.final, `agent-factory: review loop fixes (${input.runId})`)
      return branch.head()
    })
    const final = await publish()
    for (const analysis of state.analyses) {
      const { hypothesis } = analysis.freeze
      const cited = finalCalibration(analysis)
      const calibration = await calibrate(stages, analysis)
      if (!calibration.pass) return finish('failed', `${calibrationLine(hypothesis, calibration)} after the review fixes. The PR stays draft.`)
      // The dossier cites the calibration before the review, and the host does not write the dossier again.
      if (calibration.recall !== cited.recall || !sameOutputs(calibration.outputs, cited.outputs))
        return finish('failed', `After the review fixes, the calibration of ${hypothesis} gives another known recall or other output hashes than dossier/${hypothesis}.md cites. The PR stays draft.`)
      const citedRun = finalAnalysis(analysis)
      const analyzed = await runAnalysis(stages, analysis)
      if (!analyzed.pass) return finish('failed', `${analysisLine(hypothesis, analyzed)} after the review fixes. The PR stays draft.`)
      if (!sameOutputs(analyzed.outputs, citedRun.outputs))
        return finish('failed', `After the review fixes, the analysis of ${hypothesis} gives other output hashes than dossier/${hypothesis}.md cites. The PR stays draft.`)
    }
    if (!(await reproduce(stages, state.analyses, final))) return finish('failed', `The reproduction on a clean checkout of ${final.slice(0, 12)} failed after the review fixes. The PR stays draft.`)
  }
  if (!review.pass) return finish('failed', 'The review loop did not pass. The PR stays draft.')
  await step(ledger, 'ready', async () => (await deps.pulls.ready(pr), true))
  return finish('ready', 'The dossiers are ready for your review. You merge.')
}

/** What the stages after the freeze share. */
type Stages = {
  input: ResearchInput
  deps: ResearchDeps
  context: ResearchContext
  branch: Branch
  active: Profile[]
  parallel: number
  ask(batch: string, list: Question[]): Promise<Answer[]>
  /** Asks the question again in a new batch until the answer parses. */
  askUntil<T>(batch: string, question: Question, answer: string, parse: (text: string) => Parsed<T>): Promise<T>
}

/** How the stages of one prereg end the run, or null when the prereg goes on to the dossier. */
type End = { status: ResearchStatus; note: string } | null

class AnalysisScopeError extends Error {}

/** Stages 5 to 9 of one frozen prereg: the build, the calibration with one fix round, the analysis with one fix round, and two vet rounds. */
async function analyze(stages: Stages, analysis: Analysis): Promise<End> {
  const { input, deps, context, branch } = stages
  const { ledger } = deps
  const { hypothesis } = analysis.freeze
  const start = await step(ledger, `start.${hypothesis}`, () => branch.head())
  const build = async (key: string, failure?: BuildFailure): Promise<End> => {
    const log = await step(ledger, key, () =>
      buildAnalysis(context, {
        model: input.models.builder,
        branch,
        prereg: analysis.freeze,
        config: deps.config,
        active: stages.active,
        checker: deps.checker(branch),
        base: start,
        ...(failure ? { failure } : {}),
      }),
    )
    analysis.builds.push(log)
    return log.blocked.trim() ? { status: 'blocked', note: `The analysis of ${hypothesis} is blocked: ${log.blocked.trim()}` } : null
  }
  // 5 and 6. A failed first calibration goes back to the builder with the end of the output. A second failure ends the run.
  const built = await build(`build.${hypothesis}`)
  if (built) return built
  let calibration = await calibrate(stages, analysis)
  if (!calibration.pass) {
    const fixed = await build(`build.${hypothesis}.fix-1`, { step: 'calibration', round: calibration.round, reason: calibration.reason, tail: calibration.tail })
    if (fixed) return fixed
    calibration = await calibrate(stages, analysis)
    if (!calibration.pass) return { status: 'blocked', note: `${calibrationLine(hypothesis, calibration)}. ${notPushed}` }
  }
  // The analysis on a new clean checkout. A failed first analysis goes back to the builder one time, apart from the
  // calibration rounds. The calibration runs again when reads are missing or match the fix paths.
  let analyzed = await runAnalysis(stages, analysis)
  if (!analyzed.pass) {
    const { reads } = finalCalibration(analysis)
    const fixed = await build(`build.${hypothesis}.analysis-fix-1`, { step: 'analysis', round: analyzed.round, reason: analyzed.reason, tail: analyzed.tail })
    if (fixed) return fixed
    // A step, so that a resume takes the same decision after the branch moved on.
    const again = await step(ledger, `recalibrate.${hypothesis}.analysis-fix-1`, async () =>
      needsRecalibration(reads.known, reads.inject, await branch.touchedFiles(analyzed.head, await branch.head())),
    )
    if (again) {
      calibration = await calibrate(stages, analysis)
      if (!calibration.pass) return { status: 'blocked', note: `${calibrationLine(hypothesis, calibration)} after the analysis fix. ${notPushed}` }
    }
    analyzed = await runAnalysis(stages, analysis)
    if (!analyzed.pass) return { status: 'blocked', note: `${analysisLine(hypothesis, analyzed)}. ${notPushed}` }
  }

  // 9. The skeptics, then the late skeptics. The analyst answers each round that has objections.
  for (const round of [1, 2] as const) {
    const vetted = await step(ledger, `vet.${hypothesis}.${round}`, () => vet(stages, analysis, round))
    analysis.rounds.push(vetted.round)
    if (vetted.changed) {
      try {
        await step(ledger, `commit.${hypothesis}.${round}`, async () => {
          const outside = await outsidePaths(branch, (path) => path.startsWith(`analysis/${hypothesis}/`))
          if (outside.length > 0) throw new AnalysisScopeError(`After the analyst round ${round} of ${hypothesis}, changes outside analysis/${hypothesis}/ are uncommitted: ${outside.join(', ')}. ${notPushed}`)
          await branch.commit(`agent-factory: analyst changes to ${hypothesis}, round ${round} (${input.runId})`)
          return branch.head()
        })
      } catch (error) {
        if (error instanceof AnalysisScopeError) return { status: 'blocked', note: error.message }
        throw error
      }
      // Only the analysis runs again when known and inject declare reads outside analysis/<id>/.
      const { reads } = finalCalibration(analysis)
      if (needsRecalibration(reads.known, reads.inject, [`analysis/${hypothesis}/`])) {
        calibration = await calibrate(stages, analysis)
        if (!calibration.pass) return { status: 'blocked', note: `${calibrationLine(hypothesis, calibration)} after the analyst changes. ${notPushed}` }
      }
      analyzed = await runAnalysis(stages, analysis)
      if (!analyzed.pass) return { status: 'blocked', note: `${analysisLine(hypothesis, analyzed)} after the analyst changes. ${notPushed}` }
    }
    const held = await hold(stages, analysis, round)
    if (held) return held
  }
  return null
}

/** One vet round: one skeptic for each skeptic lens, then the analyst when there are objections. */
async function vet(stages: Stages, analysis: Analysis, round: 1 | 2): Promise<{ round: VetRound; changed: boolean }> {
  const { input, deps, context, branch } = stages
  const { hypothesis } = analysis.freeze
  const task = vetTask(branch, analysis)
  const lists = await pool(deps.domain.config.lenses.skeptic, stages.parallel, (lens, index) => {
    const id = `${round === 1 ? 'skeptic' : 'late-skeptic'}.${hypothesis}.${index + 1}`
    return step(deps.ledger, id, async () => {
      const submitted =
        round === 1
          ? await skeptic(context, id, input.models.skeptic, { ...task, lens })
          : await lateSkeptic(context, id, input.models.lateSkeptic, { ...task, lens, first: analysis.rounds[0]! })
      return submitted.objections
    })
  })
  const objections = numberObjections(lists, round)
  if (objections.length === 0) return { round: { objections, responses: null }, changed: false }
  const answered = await step(deps.ledger, `analyst.${hypothesis}.${round}`, () => analyst(context, input.models.analyst, { ...task, config: deps.config, round, objections }))
  return { round: { objections, responses: answered.responses }, changed: answered.changed }
}

const severe = (objection: Objection) => objection.severity === 'critical' || objection.severity === 'high'
const accepts = (answer: string) => answer === heldOptions[0] || /^\s*accept\b/i.test(answer)
const stopsRun = (answer: string) => answer === heldOptions[1] || /^\s*stop\b/i.test(answer)
const parseHeld = (answer: string): Parsed<string> =>
  accepts(answer) || stopsRun(answer) ? { value: answer } : { error: `the answer chooses neither "${heldOptions[0]}" nor "${heldOptions[1]}"` }

/** Asks the user about each conceded critical or high objection of the round, in one batch. One stop ends the run. */
async function hold(stages: Stages, analysis: Analysis, round: 1 | 2): Promise<End> {
  const { hypothesis } = analysis.freeze
  const vetted = analysis.rounds[round - 1]!
  const held = conceded([vetted]).filter((entry) => severe(entry.objection))
  if (held.length === 0) return null
  const batch = `held.${hypothesis}.${round}`
  const answers = await step(stages.deps.ledger, batch, async (): Promise<HeldAnswer[]> => {
    const questions = held.map((entry, index) => heldQuestion(hypothesis, entry.objection, entry.reason, index))
    const replies = await stages.ask(batch, questions)
    const received = held.map((entry, index) => ({ objection: entry.objection.id, answer: replies[index]?.answer ?? '' }))
    if (received.some((reply) => stopsRun(reply.answer))) return received.filter((reply) => 'value' in parseHeld(reply.answer))
    const checked: HeldAnswer[] = []
    for (const [index, entry] of held.entries()) {
      const answer = await stages.askUntil(`${batch}.${entry.objection.id}`, questions[index]!, replies[index]?.answer ?? '', parseHeld)
      checked.push({ objection: entry.objection.id, answer })
      if (stopsRun(answer)) return checked
    }
    return checked
  })
  analysis.answers.push(...answers)
  const stopped = answers.filter((answer) => stopsRun(answer.answer)).map((answer) => answer.objection)
  return stopped.length > 0 ? { status: 'stopped', note: `You stopped the run at the conceded objections ${stopped.join(', ')} of ${hypothesis}, before the dossier.` } : null
}

function heldQuestion(hypothesis: string, objection: Objection, reason: string, index: number): Question {
  return {
    id: `Q${index + 1}`,
    question: `The analyst conceded ${objection.id} (${objection.severity}) on ${hypothesis}: ${objection.title}. Accept the concession and continue to the dossier, or stop the run?`,
    why: [
      `Location: ${objection.location}`,
      `Evidence: ${objection.evidence}`,
      `Impact: ${objection.impact}`,
      `Reason of the analyst: ${reason.trim()}`,
      'The dossier shows the concession with your answer.',
    ].join('\n'),
    options: heldOptions,
    recommendation: heldOptions[0]!,
    level: 'user',
    rule: 'decision',
  }
}

const summary = (calibration: CalibrationRound): CalibrationSummary => ({
  round: calibration.round,
  recall: calibration.recall ?? 0,
  threshold: calibration.threshold,
  known: calibration.known,
  inject: calibration.inject,
  outputs: calibration.outputs,
})

/** The last calibration round. The stages give it to an agent only after it passed. */
const finalCalibration = (analysis: Analysis): CalibrationRound => analysis.calibrations.at(-1)!

/** The last analysis run. As with the calibration, the stages give it to an agent only after it passed. */
const finalAnalysis = (analysis: Analysis): AnalysisRun => analysis.runs.at(-1)!

/** What each vet agent and the writer read of one hypothesis. */
const vetTask = (branch: Branch, analysis: Analysis) => {
  const { round, command, outputs } = finalAnalysis(analysis)
  return { branch, prereg: analysis.freeze, calibration: summary(finalCalibration(analysis)), analysis: { round, command, outputs } }
}

const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, '; ')

const notPushed = 'The run did not push the branch and opened no PR.'

const sameOutputs = (a: DomainOutputs, b: DomainOutputs) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([path, sha]) => b[path] === sha)

/** The uncommitted paths that `allowed` rejects. A host commit takes all uncommitted changes. */
async function outsidePaths(branch: Branch, allowed: (path: string) => boolean): Promise<string[]> {
  const pending = await branch.pending()
  return [...pending.changed, ...pending.removed].filter((path) => !allowed(path))
}

const calibrationLine = (hypothesis: string, calibration: CalibrationRound) =>
  `Calibration round ${calibration.round} of ${hypothesis} failed (known recall ${calibration.recall ?? 'none'}, threshold ${calibration.threshold}): ${oneLine(calibration.reason)}`

const analysisLine = (hypothesis: string, run: AnalysisRun) => `Analysis round ${run.round} of ${hypothesis} failed: ${oneLine(run.reason)}`

/** Keeps the output of a command in the run store. */
function keep(deps: ResearchDeps, run: { name: string; command: string; output: string }, hypothesis: string, round: number): Promise<string> {
  const labels = { hypothesis, command: run.name, round: String(round) }
  return deps.egress.artifacts.put(new TextEncoder().encode(run.output), { source: { command: run.command }, media_type: 'text/plain', labels })
}

/** Keeps each declared output file of a command. `problem` names the first file that is missing or has another hash. */
async function keepFiles(
  deps: ResearchDeps,
  box: ResearchBox,
  run: { name: string; command: string },
  outputs: DomainOutputs,
  hypothesis: string,
  round: number,
): Promise<{ artifacts: string[]; problem: string | null }> {
  const artifacts: string[] = []
  for (const [path, hash] of Object.entries(outputs)) {
    try {
      const bytes = await box.read(path)
      if ((await artifactId(bytes)) !== hash) throw new Error(`the file does not match SHA-256 ${hash}`)
      artifacts.push(await deps.egress.artifacts.put(bytes, {
        source: { command: run.command },
        media_type: 'application/octet-stream',
        labels: { hypothesis, command: run.name, round: String(round), path },
      }))
    } catch (error) {
      return { artifacts, problem: `${run.name} output ${path}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  return { artifacts, problem: null }
}

/** Keeps the output and each declared output file before another command can replace or remove them. */
async function keepOutputs(deps: ResearchDeps, box: ResearchBox, run: DomainRun, hypothesis: string, round: number): Promise<{ run: DomainRun; artifacts: string[] }> {
  const output = await keep(deps, run, hypothesis, round)
  const files = await keepFiles(deps, box, run, run.json?.outputs ?? {}, hypothesis, round)
  const artifacts = [output, ...files.artifacts]
  return files.problem === null ? { run, artifacts } : { run: { ...run, json: null, problem: files.problem }, artifacts }
}

/**
 * Runs a command on a run box under a compute entry `key`, when the platform meters run boxes. A planned stop keeps
 * the entry open, because the next call continues the same work.
 */
async function metered<T>(deps: ResearchDeps, key: string, run: () => Promise<T>): Promise<T> {
  if (!deps.compute) return run()
  startCompute(deps.ledger, key, key, deps.compute.runBox)
  let stopped = false
  try {
    return await run()
  } catch (error) {
    stopped = error instanceof PlannedStop
    throw error
  } finally {
    if (!stopped) finishCompute(deps.ledger, key)
  }
}

/** The expected compute cost of `seconds` of units on the scan boxes. */
function computeEstimate(seconds: number, deps: ResearchDeps): string {
  if (!deps.containerPrices || !deps.scanBoxes) return 'unknown, because CONTAINER_PRICES is not set'
  return `about ${formatUsd(computeCost(seconds, deps.scanBoxes.instance, deps.containerPrices))}`
}

/** The note of the cost cap question about the compute cost of the units. */
function planNote(plan: PlanRecord | undefined, deps: ResearchDeps): string {
  if (!plan) return 'The compute cost is unknown until stage 6 runs plan.'
  return `The last plan (${plan.hypothesis}, calibration round ${plan.round}) has ${plan.units} units of ${plan.seconds} expected seconds. The expected compute cost is ${computeEstimate(plan.seconds, deps)}.`
}

/**
 * Stage 6: known and inject on a clean checkout of the run branch head, gated on the threshold of the frozen prereg
 * (decision 2). The output files of the commands stay out of the run branch, so no host commit and no builder takes them.
 */
async function calibrate(stages: Stages, analysis: Analysis): Promise<CalibrationRound> {
  const { deps, branch } = stages
  const { hypothesis, path } = analysis.freeze
  const round = analysis.calibrations.length + 1
  const key = `calibrate.${hypothesis}.${round}`
  const calibration = await step(deps.ledger, key, async (): Promise<CalibrationRound> => {
    const threshold = preregThreshold(new TextDecoder().decode(await branch.tree.read(`/${path}`)))
    const head = await branch.head()
    if (fansOut(deps.domain.config)) return fanOutRound(stages, analysis, { key, round, head, threshold })
    const box = await deps.cleanBox(head, key)
    // A new copy runs known again. Reuse its snapshot only on that copy, because inject can change its files.
    const knownRun = await metered(deps, `${key}.known`, () => runDomainCommand(deps.config, box, 'known', path))
    const knownId = await artifactId(new TextEncoder().encode(JSON.stringify(knownRun)))
    const known = await step(deps.ledger, `${key}.known.${box.id}.${knownId}`, async () => keepOutputs(deps, box, knownRun, hypothesis, round))
    const injectRun = await metered(deps, `${key}.inject`, () => runDomainCommand(deps.config, box, 'inject', path))
    const inject = await keepOutputs(deps, box, injectRun, hypothesis, round)
    const verdict = calibrationVerdict(known.run, inject.run, threshold)
    return {
      round,
      head,
      recall: verdict.recall,
      threshold,
      known: known.artifacts,
      inject: inject.artifacts,
      outputs: verdict.outputs,
      reads: { known: known.run.json?.reads ?? null, inject: inject.run.json?.reads ?? null },
      ...(verdict.pass ? { pass: true, reason: '', tail: '' } : { pass: false, reason: verdict.reason, tail: verdict.tail }),
    }
  })
  analysis.calibrations.push(calibration)
  return calibration
}

/** The plan and the fetched data of one fan-out round. `reason` and `tail` are set when plan or a fetch failed. */
type Planned = { plan: string; fetch: string[]; fetched: Record<string, DomainOutputs>; units: PlanUnit[]; reason: string; tail: string }

/**
 * Stage 6 of a fan-out config: plan and fetch on one clean checkout, the units on the scan boxes, then merge on a new
 * clean checkout with the units directory. A scan box never gets the holdout file or a holdout target (RG1).
 */
async function fanOutRound(stages: Stages, analysis: Analysis, at: { key: string; round: number; head: string; threshold: number }): Promise<CalibrationRound> {
  const { deps, input } = stages
  const { ledger } = deps
  const { key, round, head, threshold } = at
  const { hypothesis, path, sha256 } = analysis.freeze
  const boxes = deps.scanBoxes
  if (!boxes) throw new StopError('the research config has plan, fetch, unit and merge, but this platform gives no scan boxes for the units')
  const planned = await step(ledger, `${key}.plan`, async (): Promise<Planned> => {
    const box = await deps.cleanBox(head, `${key}.plan`)
    const planRun = await metered(deps, `${key}.plan`, () => runPlan(deps.config, box, path))
    const plan = await keep(deps, planRun, hypothesis, round)
    if (planRun.problem !== null) return { plan, fetch: [], fetched: {}, units: [], reason: planRun.problem, tail: planRun.tail }
    const refused = holdoutRefusal(planRun.json.targets, deps.domain.holdout.targets)
    if (refused !== null) return { plan, fetch: [], fetched: {}, units: [], reason: refused, tail: '' }
    const fetch: string[] = []
    const fetched: Record<string, DomainOutputs> = {}
    for (const target of planRun.json.targets) {
      const fetchRun = await metered(deps, `${key}.fetch.${target}`, () => runFetch(deps.config, box, path, target))
      fetch.push(await keep(deps, fetchRun, hypothesis, round))
      if (fetchRun.problem !== null) return { plan, fetch, fetched, units: [], reason: `fetch ${target}: ${fetchRun.problem}`, tail: fetchRun.tail }
      const files = await keepFiles(deps, box, fetchRun, fetchRun.json.outputs, hypothesis, round)
      fetch.push(...files.artifacts)
      if (files.problem !== null) return { plan, fetch, fetched, units: [], reason: `fetch ${target}: ${files.problem}`, tail: '' }
      fetched[target] = fetchRun.json.outputs
    }
    const { units } = planRun.json
    const seconds = units.reduce((sum, unit) => sum + unit.expected_seconds, 0)
    const notice = `The plan of ${hypothesis}, calibration round ${round}, has ${units.length} units of ${seconds} expected seconds. The expected compute cost is ${computeEstimate(seconds, deps)}.`
    deps.log(`budget notice: ${notice}`)
    // The notice only informs, and the run log has it, so a failed post does not stop the run.
    try {
      await deps.channel.notice?.(input.runId, notice)
    } catch (error) {
      deps.log(`budget notice failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    ledger.put(planKey, { commit: head, hypothesis, round, units: units.length, seconds } satisfies PlanRecord)
    return { plan, fetch, fetched, units, reason: '', tail: '' }
  })
  const fanout: FanOutRound = { plan: planned.plan, fetch: planned.fetch, units: [], failed: [], retries: 0, conflicts: [] }
  if (planned.reason) {
    return { round, head, recall: null, threshold, known: [], inject: [], outputs: {}, reads: { known: null, inject: null }, pass: false, reason: planned.reason, tail: planned.tail, fanout }
  }
  let commitFiles: Promise<InputFile[]> | undefined
  const files = () => (commitFiles ??= deps.branches.view(head).then((tree) => treeInputs(tree, [deps.domain.config.holdout])))
  const prereg = { hypothesis, path, sha256 }
  const results = await runUnits(planned.units, {
    ledger,
    boxes,
    artifacts: deps.egress.artifacts,
    config: deps.config,
    runId: input.runId,
    commit: head,
    prereg,
    round,
    parallel: input.parallel ?? defaultUnitParallel,
    inputs: unitInputs(files, planned.fetched, deps.egress.artifacts),
    log: deps.log,
  })
  const keys = new Set(planned.units.map((unit) => unitKey({ commit: head, prereg }, unit.id)))
  fanout.units = results.map((result) => ({ id: result.id, status: result.status, attempts: result.attempts, ...(result.reason !== undefined ? { reason: result.reason } : {}) }))
  fanout.failed = results.filter((result) => result.status === 'failed').map((result) => result.id)
  fanout.retries = results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0)
  fanout.conflicts = unitConflicts(ledger).filter((conflict) => keys.has(conflict.key))
  const box = await deps.cleanBox(head, `${key}.merge`, await unitsFiles(results, deps.egress.artifacts))
  const merged = await metered(deps, `${key}.merge`, () => runMerge(deps.config, box, path, unitsDir))
  const known = await keepOutputs(deps, box, merged.known, hypothesis, round)
  const inject = await keepOutputs(deps, box, merged.inject, hypothesis, round)
  const verdict = calibrationVerdict(known.run, inject.run, threshold)
  return {
    round,
    head,
    recall: verdict.recall,
    threshold,
    known: known.artifacts,
    inject: inject.artifacts,
    outputs: verdict.outputs,
    reads: { known: known.run.json?.reads ?? null, inject: inject.run.json?.reads ?? null },
    ...(verdict.pass ? { pass: true, reason: '', tail: '' } : { pass: false, reason: verdict.reason, tail: verdict.tail }),
    fanout,
  }
}

/**
 * Stage 6: analyze on a new clean checkout of the run branch head, after a calibration passed. Its outputs must not
 * give another hash for a path of the final calibration. As with the calibration, no output file goes on the run branch.
 */
async function runAnalysis(stages: Stages, analysis: Analysis): Promise<AnalysisRun> {
  const { deps, branch } = stages
  const { hypothesis, path } = analysis.freeze
  const round = analysis.runs.length + 1
  const key = `analysis.${hypothesis}.${round}`
  const run = await step(deps.ledger, key, async (): Promise<AnalysisRun> => {
    const head = await branch.head()
    const box = await deps.cleanBox(head, key)
    const analyzeRun = await metered(deps, `${key}.analyze`, () => runDomainCommand(deps.config, box, 'analyze', path, hypothesis))
    const kept = await keepOutputs(deps, box, analyzeRun, hypothesis, round)
    const verdict = analysisVerdict(kept.run, finalCalibration(analysis).outputs)
    const [command = '', ...files] = kept.artifacts
    return {
      round,
      head,
      outputs: verdict.outputs,
      command,
      files,
      ...(verdict.pass ? { pass: true, reason: '', tail: '' } : { pass: false, reason: verdict.reason, tail: verdict.tail }),
    }
  })
  analysis.runs.push(run)
  return run
}

/**
 * Stage 11: reproduce of each prereg on one clean checkout of `head`, against the outputs of its last calibration and
 * its last analysis. True when each output hash matches.
 */
async function reproduce(stages: Stages, analyses: Analysis[], head: string): Promise<boolean> {
  const { deps } = stages
  let box: Promise<Machine> | undefined
  for (const analysis of analyses) {
    const { hypothesis, path } = analysis.freeze
    const calibration = finalCalibration(analysis)
    const expected = { ...calibration.outputs, ...finalAnalysis(analysis).outputs }
    const result = await step(deps.ledger, `reproduce.${hypothesis}.${head}`, async (): Promise<Reproduction> => {
      box ??= deps.cleanBox(head, `reproduce.${head}`)
      const machine = await box
      const run = await metered(deps, `reproduce.${hypothesis}.${head.slice(0, 12)}`, () => runDomainCommand(deps.config, machine, 'reproduce', path))
      const verdict = compareReproduction(expected, run)
      const artifact = await keep(deps, run, hypothesis, calibration.round)
      return { head, pass: verdict.pass, mismatches: verdict.mismatches, missing: verdict.missing, reason: verdict.pass ? '' : verdict.reason, artifact }
    })
    analysis.reproductions.push(result)
  }
  return analyses.every((analysis) => analysis.reproductions.at(-1)?.pass === true)
}

/** Stops the run when a frozen file on the run branch is missing, or has another hash than the ledger records. */
async function checkFrozen(branch: Branch, frozen: Freeze[]): Promise<void> {
  for (const entry of frozen) {
    const bytes = await branch.tree.read(`/${entry.path}`).catch(() => null)
    if (bytes === null || (await artifactId(bytes)) !== entry.sha256)
      throw new StopError(`the frozen prereg ${entry.path} on ${branch.name} changed after the freeze: its SHA-256 is not ${entry.sha256}`)
  }
}

/**
 * Writes the prereg at the next free version on the run branch, and commits it. A file that exists stays as it is.
 * The run reuses a matching version only when that path did not exist at the base commit.
 */
async function freeze(branch: Branch, prereg: Prereg, runId: string, baseTree: Branch['tree']): Promise<Freeze> {
  let version = 1
  while ((await branch.tree.stat(`/prereg/${prereg.hypothesis}-v${version}.md`)) !== null) version++
  if (version > 1) {
    const newest = await freezePrereg(prereg, {}, { version: version - 1 })
    const bytes = await branch.tree.read(`/${newest.path}`).catch(() => null)
    if ((await baseTree.stat(`/${newest.path}`)) === null && bytes !== null && (await artifactId(bytes)) === newest.sha256) {
      await branch.commit(`agent-factory: freeze ${newest.path} (${runId})`)
      return { hypothesis: newest.hypothesis, version: newest.version, path: newest.path, sha256: newest.sha256, commit: await branch.head() }
    }
  }
  const frozen = await freezePrereg(prereg, {}, { version })
  await branch.tree.mkdir('/prereg')
  await branch.tree.write(`/${frozen.path}`, new TextEncoder().encode(frozen.markdown))
  await branch.commit(`agent-factory: freeze ${frozen.path} (${runId})`)
  return { hypothesis: frozen.hypothesis, version: frozen.version, path: frozen.path, sha256: frozen.sha256, commit: await branch.head() }
}

/** The research intake as a development intake, so that the confirm question and its stop rule (route) are the same. */
const asDevelopIntake = (intake: ResearchIntake) => ({ ...intake, larger: false, passes: 1 as const, reason: '' })

const capId = (intake: ResearchIntake) => `Q${intake.questions.length + 2}`

/**
 * The questions of the host after the questions of the agent: confirm the program (rule scope), and the cost cap (rule
 * spend). An undefined cap recommends no cap. `notes` go into the why of the cap question.
 */
function hostQuestions(intake: ResearchIntake, cap: number | undefined, notes: string[]): [Question, Question] {
  const [confirm] = routeQuestions(asDevelopIntake(intake))
  const recommended = cap === undefined ? noCap : `${cap} USD`
  return [
    { ...confirm!, question: 'Is this the program? Correct it in your own words if it is not.', level: 'user', rule: 'scope' },
    {
      id: capId(intake),
      question: 'What is the cost cap of this run?',
      why: [
        'At the cap, the host posts a notice, and the run continues. At twice the cap, the host asks you to raise the cap or to stop the run. Write a USD number for another cap.',
        ...notes,
      ].join(' '),
      options: cap === undefined ? [noCap] : [recommended, noCap],
      recommendation: recommended,
      level: 'user',
      rule: 'spend',
    },
  ]
}

/** The cap in USD, or undefined for no cap. A cap needs a positive USD number, and `checkPrices` must accept the prices. */
function parseCap(answer: string, checkPrices: () => void): Parsed<number | undefined> {
  const text = answer.trim()
  if (/^no\b/i.test(text)) return { value: undefined }
  try {
    const cap = parseBudget(text.replace(/^\$\s*/, '').replace(/\s*usd$/i, ''))
    checkPrices()
    return { value: cap }
  } catch (error) {
    if (error instanceof StopError) return { error: error.message }
    throw error
  }
}

/** Sets the intake cap as the budget, also over the budget of this invocation. "No cap" removes the limit. */
function applyCap(ledger: Ledger, cap: number | undefined): void {
  if (cap !== undefined) {
    resolveBudget(ledger, cap, cap)
    return
  }
  clearBudget(ledger)
}

const pickOption = (hypothesis: NumberedHypothesis) => `${hypothesis.id}: ${hypothesis.title}`

function pickQuestion(hypotheses: NumberedHypothesis[]): Question {
  const options = [...hypotheses.map(pickOption), noneOption]
  return {
    id: 'Q1',
    question: 'Which hypotheses do you pick for a prereg? Give one or more option letters or hypothesis IDs, for example "a, c".',
    why: hypotheses.map((hypothesis) => `${hypothesis.id}: ${hypothesis.statement.trim()} Kill criterion: ${hypothesis.kill_criterion.trim()}`).join('\n'),
    options,
    recommendation: options[0]!,
    level: 'user',
    rule: 'decision',
  }
}

/**
 * The picked IDs, in the order of the merge. An answer gives option letters or hypothesis IDs. The channel already
 * changed a single letter to the text of its option. An answer that names no hypothesis, or an unknown ID, is an error.
 */
function parsePicks(answer: string, hypotheses: NumberedHypothesis[]): Parsed<string[]> {
  const text = answer.trim()
  if (/^none\b/i.test(text)) return { value: [] }
  const known = hypotheses.map((hypothesis) => hypothesis.id)
  const option = hypotheses.find((hypothesis) => pickOption(hypothesis) === text)
  const named = option
    ? [option.id]
    : text
        .split(/[\s,;]+/)
        .map((token) => token.replace(/[).:]+$/, '').toLowerCase())
        .flatMap((token) => (/^hyp-\d+$/.test(token) ? [token] : /^[a-z]$/.test(token) ? [known[token.charCodeAt(0) - 97] ?? `option ${token}`] : []))
  const unknown = named.filter((id) => !known.includes(id))
  if (unknown.length > 0) return { error: `the pick answer "${text}" names no hypothesis of this run: ${unknown.join(', ')}` }
  if (named.length === 0) return { error: `the pick answer "${text}" names no hypothesis: give option letters, hypothesis IDs, or None` }
  return { value: known.filter((id) => named.includes(id)) }
}

function approveQuestion(draft: Prereg, index: number): Question {
  return {
    id: `Q${index + 1}`,
    question: `Approve the prereg of ${draft.hypothesis} for the freeze? To reject it, write the reason. To drop the hypothesis without a freeze, answer Drop.`,
    why: [
      `Known recall: ${draft.known_recall}.`,
      ...draft.sections.map((section) => `${section.name.trim()}: ${section.text.trim()}`),
      'After the freeze, a change needs a new version with a reason.',
    ].join('\n'),
    options: approveOptions,
    recommendation: approveOptions[0]!,
    level: 'user',
    rule: 'decision',
  }
}

const approves = (answer: string) => answer === approveOptions[0] || /^\s*(yes|approve)\b/i.test(answer)
const drops = (answer: string) => answer === approveOptions[2] || /^\s*drop\b/i.test(answer)

/** One row of the Usage section for a review pass, with the tokens and USD of all its agents. */
function reviewRow(review: Review, index: number): UsageRow {
  const { tokens, usd, unpriced } = review.usage
  return { step: `review.${index + 1}`, model: 'review loop', tokens, usd, unpriced }
}

/** The frozen package of the review pass: the program, and what the change is. */
function reviewAsk(input: ResearchInput, analyses: Analysis[]): string {
  return [
    input.program.trim(),
    '',
    `The change is the analysis of the frozen preregs ${analyses.map((analysis) => analysis.freeze.path).join(', ')} in analysis/<id>/.`,
    'The host wrote prereg/ and dossier/. A fix can change only analysis/.',
  ].join('\n')
}

/**
 * The PR description, written by the host (G7). Only the dossiers are visible. The run, the program, the decisions and
 * the holdout lock are in one collapsed block.
 */
function prBody(input: ResearchInput, analyses: Analysis[], answers: Answer[]): string {
  return [
    ...analyses.map((analysis) => `- dossier/${analysis.freeze.hypothesis}.md: outcome ${analysis.dossier?.outcome ?? 'none'}, prereg ${analysis.freeze.path}`),
    '',
    '<details><summary>Run, program, decisions and holdout lock</summary>',
    '',
    `agent-factory run \`${input.runId}\` (${input.source}) opened this draft PR. It stays draft until the review loop passes.`,
    '',
    '# Program',
    '',
    ...input.program.trim().split('\n').map((line) => `> ${line}`),
    '',
    ...decisionLists(answers, { user: '# Decisions of the user', run: '# Decisions the run made' }),
    '# Holdout lock',
    '',
    ...lockLines,
    '',
    '</details>',
  ].join('\n')
}

function objectionLines(rounds: VetRound[], answers: HeldAnswer[]): string[] {
  return rounds.flatMap((round, index) => {
    if (round.objections.length === 0) return [`- Vet round ${index + 1}: no objections`]
    return round.objections.map((objection) => {
      const response = responseLine(objection.id, round.responses)
      const user = answers.find((entry) => entry.objection === objection.id)
      return [
        `- Vet round ${index + 1}, ${objection.id} (${objection.severity}, lens ${objection.lens}): ${objection.title} (${objection.location}).`,
        response ? ` Analyst: ${oneLine(response)}` : '',
        user ? ` User: ${user.answer}` : '',
      ].join('')
    })
  })
}

function reproductionLines(reproduction: Reproduction): string[] {
  const at = `- Reproduction at ${reproduction.head.slice(0, 12)} (output artifact ${reproduction.artifact}):`
  if (reproduction.pass) return [`${at} PASS, each hash matches`]
  const listed = [
    ...reproduction.mismatches.map((entry) => `  - ${entry.path}: expected ${entry.expected}, reproduce gave ${entry.actual}`),
    ...reproduction.missing.map((path) => `  - ${path}: reproduce gave no hash`),
  ]
  return [`${at} FAIL${listed.length > 0 ? '' : `: ${oneLine(reproduction.reason)}`}`, ...listed]
}

function fanOutLines(fanout: FanOutRound): string[] {
  const failed = fanout.units.filter((unit) => unit.status === 'failed')
  return [
    `  - Fan-out: plan output ${fanout.plan}, ${fanout.units.length} units, ${fanout.retries} retries, ${failed.length > 0 ? `failed units: ${failed.map((unit) => `${unit.id} (${oneLine(unit.reason ?? '')})`).join(', ')}` : 'no failed unit'}`,
    ...fanout.conflicts.map((conflict) => `  - Second result of unit ${conflict.unit}: SHA-256 ${conflict.second}. The run kept the first result, SHA-256 ${conflict.first}.`),
  ]
}

function analysisLines(analysis: Analysis): string[] {
  const { hypothesis } = analysis.freeze
  return [
    `## Analysis of ${hypothesis}`,
    '',
    ...analysis.builds.map((log, index) => `- Build${index > 0 ? ` fix ${index}` : ''}: ${log.blocked.trim() ? `blocked: ${log.blocked.trim()}` : oneLine(log.summary)}`),
    ...analysis.calibrations.flatMap((calibration) => [
      `- Calibration round ${calibration.round} at ${calibration.head.slice(0, 12)}: ${calibration.pass ? 'PASS' : 'FAIL'}, known recall ${calibration.recall ?? 'none'}, threshold ${calibration.threshold}, known output ${calibration.known.join(', ')}, inject output ${calibration.inject.join(', ')}${calibration.pass ? '' : `. ${oneLine(calibration.reason)}`}`,
      ...(calibration.fanout ? fanOutLines(calibration.fanout) : []),
    ]),
    ...analysis.runs.map(
      (run) =>
        `- Analysis round ${run.round} at ${run.head.slice(0, 12)}: ${run.pass ? 'PASS' : 'FAIL'}, analyze output ${run.command}, output files ${run.files.join(', ') || 'none'}${run.pass ? '' : `. ${oneLine(run.reason)}`}`,
    ),
    ...objectionLines(analysis.rounds, analysis.answers),
    ...(analysis.dossier ? [`- Dossier: dossier/${hypothesis}.md, outcome ${analysis.dossier.outcome}`] : []),
    ...analysis.reproductions.flatMap(reproductionLines),
    '',
  ]
}

function renderReport(state: ReportState, status: ResearchStatus, note: string, answers: Answer[], usage: string[]): string {
  const triage = (report: string) => /^- Triage: (.*)$/m.exec(report)?.[1] ?? ''
  return [
    `# Research run: ${status.toUpperCase()}`,
    '',
    ...(state.pr ? [`PR: ${state.pr.url}`, ''] : []),
    `- Run: ${state.input.runId}`,
    `- Source: ${state.input.source}`,
    ...(state.intake ? [`- Program: ${state.intake.title}`] : []),
    ...(state.branch ? [`- Branch: ${state.branch} ${state.pushed ? `(pushed at ${state.pushed.slice(0, 12)})` : '(local, not pushed)'}`] : []),
    '',
    note,
    '',
    ...(state.surveys.length > 0
      ? ['## Surveys', '', ...state.surveys.map((entry) => `- ${entry.lens} (${entry.claims.length} claims): ${entry.summary.trim()}`), '']
      : []),
    ...(state.hypotheses.length > 0 ? ['## Hypotheses', '', ...state.hypotheses.map((hypothesis) => `- ${pickOption(hypothesis)}`), ''] : []),
    ...(state.picked ? ['## Picks', '', state.picked.length > 0 ? state.picked.map((id) => `- ${id}`).join('\n') : '- none', ''] : []),
    ...(state.frozen.length > 0 || state.dropped.length > 0
      ? [
          '## Frozen preregs',
          '',
          ...state.frozen.map((entry) => `- ${entry.path}: SHA-256 ${entry.sha256}, commit ${entry.commit.slice(0, 12)}`),
          ...(state.dropped.length > 0 ? [`- Dropped at the approval: ${state.dropped.join(', ')}`] : []),
          '',
        ]
      : []),
    ...state.analyses.flatMap(analysisLines),
    ...(state.reviews.length > 0
      ? [
          '## Review loop',
          '',
          ...state.reviews.map(
            (review, index) =>
              `- Pass ${index + 1}: ${review.pass ? 'PASS' : 'FAIL'}, ${triage(review.report)}, ${review.final === review.head ? 'no fixes' : `fixes from ${review.branch}`}`,
          ),
          '',
        ]
      : []),
    '## Holdout lock',
    '',
    ...lockLines,
    '',
    ...usage,
    '',
    ...decisionSections(answers),
  ].join('\n')
}
