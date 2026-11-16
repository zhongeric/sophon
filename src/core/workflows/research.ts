import type { Contracts } from 'nanocode-ts'
import { artifactId } from '../artifacts.ts'
import { mergeHypotheses, type NumberedHypothesis } from '../claims.ts'
import { checkEgress, type EgressHost } from '../egress.ts'
import { step, type Ledger } from '../ledger.ts'
import { route, routeQuestions } from '../plan.ts'
import type { AgentStore, Branch, Branches, Files, Guides } from '../platform.ts'
import { pool } from '../pool.ts'
import { freezePrereg, type Prereg } from '../prereg.ts'
import type { Credentials, Provider } from '../providers.ts'
import { asker, decisions, type Answer, type Channel, type Question } from '../questions.ts'
import { generate, preregister, researchEgress, researchIntake, survey, type LensSurvey, type ResearchContext, type ResearchIntake } from '../research-steps.ts'
import type { ResearchDomain } from '../research.ts'
import type { ModelChoice } from '../roles.ts'
import { StopError } from '../stop.ts'
import { BudgetStop, budgetGate, checkPriced, clearBudget, parseBudget, resolveBudget, usageOf, usageSection, type Prices } from '../usage.ts'
import { decisionSections, defaultAllowedModels } from './code-review-loop.ts'

/** The two generators run on two model families. */
export type ResearchModels = { intake: ModelChoice; surveyor: ModelChoice; generators: [ModelChoice, ModelChoice]; preregistrar: ModelChoice }

const opus: ModelChoice = { provider: 'claude', model: 'claude-opus-5-5' }

export const defaultResearchModels: ResearchModels = {
  intake: opus,
  surveyor: opus,
  generators: [opus, { provider: 'codex', model: 'gpt-6.1-sol' }],
  preregistrar: opus,
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
  /** At most this many surveyors or preregistrars at the same time. */
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
  /** The branches of the notebook. The run commits the frozen preregs on a branch of its own, and never pushes. */
  branches: Branches
  domain: ResearchDomain
  egress: EgressHost
  log(line: string): void
}

/** A frozen prereg as the ledger records it. */
export type Freeze = { hypothesis: string; version: number; path: string; sha256: string; commit: string }

export type ResearchStatus = 'frozen' | 'stopped'
export type ResearchResult = { status: ResearchStatus; branch: string | null; frozen: Freeze[]; report: string }

const defaultParallel = 3
/** The cap that the intake question recommends when the run has no budget. */
const defaultCap = 25
const noCap = 'No cap'
const noneOption = 'None'
const approveOptions = ['Approve and freeze', 'Reject (write the reason)', 'Drop the hypothesis']
const frozenKey = 'frozen'
/** The cap of the intake answer, after the host applied it. Null is no cap. */
const capKey = 'cap'
type Cap = { usd: number | null }
type Parsed<T> = { value: T } | { error: string }

const choices = (models: ResearchModels) => [models.intake, models.surveyor, ...models.generators, models.preregistrar]

const researchModelIds = (models: ResearchModels): string[] => choices(models).map((choice) => choice.model)

export const researchProviders = (models: ResearchModels): Set<Provider> => new Set(choices(models).map((choice) => choice.provider))

function checkResearchModels(models: ResearchModels, allowed = defaultAllowedModels): void {
  const refused = [...new Set(researchModelIds(models))].filter((model) => !allowed.includes(model))
  if (refused.length > 0) throw new StopError(`models outside the allowed list (${allowed.join(', ')}): ${refused.join(', ')}`)
  // A models file can give another count, so the host also checks the count at run time.
  const generators: ModelChoice[] = models.generators
  if (generators.length !== 2) throw new StopError(`the research run needs exactly two generators, not ${generators.length}`)
  if (generators[0]!.provider === generators[1]!.provider) throw new StopError(`the two generators must use two model families, but both use ${generators[0]!.provider}`)
}

/**
 * The host freezes and commits a prereg only after the user approves it. The run stops before stage 5. Every step is
 * in the ledger, so the same run ID resumes without repeating finished steps.
 */
export async function research(input: ResearchInput, deps: ResearchDeps): Promise<ResearchResult> {
  const stop: { finish?: Finish } = {}
  try {
    return await researchSteps(input, deps, stop)
  } catch (error) {
    if (error instanceof BudgetStop && stop.finish) return stop.finish('stopped', `The run ${error.message}. Reason: cost budget.`)
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
}

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
  const prices = deps.prices ?? {}
  // After the intake, the recorded budget is the cap, so that a resume keeps the cap or a later raise.
  const capped = ledger.get<Cap>(capKey)
  const recordedBudget = capped ? (capped.usd ?? undefined) : input.budget
  if (resolveBudget(ledger, recordedBudget, input.budgetOverride) !== undefined) checkPriced(researchModelIds(models), prices)
  const budget = budgetGate({ channel: deps.channel, ledger, log: deps.log, prices, runId: input.runId })
  // A resume without --budget must not apply the override again, so the recorded input does not keep it.
  const { budgetOverride, ...recorded } = input
  ledger.put('input', recorded)

  const state: ReportState = { input, intake: null, surveys: [], hypotheses: [], picked: null, branch: null, frozen: [], dropped: [] }
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
  const questions = asker(ledger, deps.channel, input.runId, deps.log)
  const ask = async (batch: string, list: Question[]): Promise<Answer[]> => {
    await questions.post(batch, list)
    return questions.wait(batch)
  }
  // The ledger keeps an answer that does not parse, so the question goes again in a new batch.
  const askUntil = async <T>(batch: string, question: Question, answer: string, parse: (text: string) => Parsed<T>): Promise<T> => {
    for (let round = 2; ; round++) {
      const parsed = parse(answer)
      if ('value' in parsed) return parsed.value
      deps.log(`the answer ${JSON.stringify(answer)} (${batch}): ${parsed.error}, asking again`)
      const [again] = await ask(`${batch}.${round}`, [{ ...question, id: 'Q1', why: `${parsed.error}.\n${question.why}` }])
      answer = again?.answer ?? ''
    }
  }
  const finish: Finish = async (status, note) => {
    const limit = budget.limit()
    const usage = usageSection(usageOf(ledger).agents, prices, limit === undefined ? undefined : { limit, spent: budget.spent() })
    const report = renderReport(state, status, note, decisions(ledger), usage)
    deps.files.write('report.md', report)
    ledger.put('result', { status, branch: state.branch, frozen: state.frozen })
    return { status, branch: state.branch, frozen: state.frozen, report }
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
  // Without a price for each model, a cap cannot work, so the question recommends no cap.
  const priced = researchModelIds(models).every((model) => model in prices)
  const [confirm, capAsk] = hostQuestions(intook, priced ? (budget.limit() ?? defaultCap) : undefined)
  const answers = await ask('intake', [...intook.questions, confirm, capAsk])
  if (route(asDevelopIntake(intook), answers).stop) return finish('stopped', 'You stopped the run at intake.')
  if (!capped) {
    const first = answers.find((answer) => answer.id === capAsk.id)?.answer ?? noCap
    const cap = await askUntil('cap', capAsk, first, (text) => parseCap(text, researchModelIds(models), prices))
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
  const dropped = state.dropped.length > 0 ? `, dropped ${state.dropped.join(', ')}` : ''
  return finish('frozen', `The run froze ${state.frozen.length} preregs on ${branchName}${dropped}, did not push the branch, and stopped before stage 5.`)
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
 * spend). An undefined cap recommends no cap.
 */
function hostQuestions(intake: ResearchIntake, cap: number | undefined): [Question, Question] {
  const [confirm] = routeQuestions(asDevelopIntake(intake))
  const recommended = cap === undefined ? noCap : `${cap} USD`
  return [
    { ...confirm!, question: 'Is this the program? Correct it in your own words if it is not.', level: 'user', rule: 'scope' },
    {
      id: capId(intake),
      question: 'What is the cost cap of this run?',
      why: [
        'At the cap, the host asks you to raise it or to stop the run before it opens the next agent turn. Write a USD number for another cap.',
        ...(cap === undefined ? ['MODEL_PRICES has no price for some models of this run, and a cap needs a price for each model.'] : []),
      ].join(' '),
      options: cap === undefined ? [noCap] : [recommended, noCap],
      recommendation: recommended,
      level: 'user',
      rule: 'spend',
    },
  ]
}

/** The cap in USD, or undefined for no cap. A cap needs a positive USD number and a price for each model. */
function parseCap(answer: string, models: string[], prices: Prices): Parsed<number | undefined> {
  const text = answer.trim()
  if (/^no\b/i.test(text)) return { value: undefined }
  try {
    const cap = parseBudget(text.replace(/^\$\s*/, '').replace(/\s*usd$/i, ''))
    checkPriced(models, prices)
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

function renderReport(state: ReportState, status: ResearchStatus, note: string, answers: Answer[], usage: string[]): string {
  return [
    `# Research run: ${status.toUpperCase()}`,
    '',
    `- Run: ${state.input.runId}`,
    `- Source: ${state.input.source}`,
    ...(state.intake ? [`- Program: ${state.intake.title}`] : []),
    ...(state.branch ? [`- Branch: ${state.branch} (local, not pushed)`] : []),
    '',
    note,
    '',
    ...(state.surveys.length > 0
      ? ['## Surveys', '', ...state.surveys.map((entry) => `- ${entry.lens} (${entry.claims.length} claims): ${entry.summary.trim()}`), '']
      : []),
    ...(state.hypotheses.length > 0 ? ['## Hypotheses', '', ...state.hypotheses.map((hypothesis) => `- ${pickOption(hypothesis)}`), ''] : []),
    ...(state.picked ? ['## Picks', '', state.picked.length > 0 ? state.picked.map((id) => `- ${id}`).join('\n') : '- none', ''] : []),
    ...(state.frozen.length > 0
      ? ['## Frozen preregs', '', ...state.frozen.map((entry) => `- ${entry.path}: SHA-256 ${entry.sha256}, commit ${entry.commit.slice(0, 12)}`), '']
      : []),
    '## Holdout lock',
    '',
    '- The lock binds the agents only, not the commands of a box (RG1).',
    '- The lock does not bind web search, because web search runs at the provider (RG10).',
    '',
    ...usage,
    '',
    ...decisionSections(answers),
  ].join('\n')
}
