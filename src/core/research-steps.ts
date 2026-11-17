import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { hostFetch, runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { isProtected, type RepoConfig } from './checks.ts'
import {
  checkDossier,
  checkHypotheses,
  checkObjections,
  checkResponses,
  checkSurvey,
  submitDossier,
  submitHypotheses,
  submitObjections,
  submitResponses,
  submitSurvey,
  type Dossier,
  type Hypothesis,
  type NumberedHypothesis,
  type Objection,
  type ResearchSources,
  type Responses,
  type Survey,
} from './claims.ts'
import { build, type BuildLog, type DevelopContext } from './develop-steps.ts'
import type { Egress } from './egress.ts'
import { inScope } from './plan.ts'
import type { Branch, Checker, Guides } from './platform.ts'
import { checkPrereg, coreSections, submitPrereg, type Prereg } from './prereg.ts'
import type { Profile } from './profiles.ts'
import { checkQuestions, decisionsFile, decisionsLine, questionsSchema, type Question } from './questions.ts'
import type { ResearchDomain } from './research.ts'
import { instructions, researchRoles, type ModelChoice, type Role } from './roles.ts'
import { StopError } from './stop.ts'
import { allowFiles, createWorkspace, guard, readOnly } from './workspace.ts'

/** What every agent of one research run shares. `tree` is the notebook at the base commit. */
export type ResearchContext = {
  host: AgentHost
  guides: Guides
  domain: ResearchDomain
  /** The program, verbatim. */
  program: string
  tree: FileSystem.FileSystem
}

/** What the research intake agent understood of the program. */
export type ResearchIntake = { title: string; summary: string; slug: string; questions: Question[] }

/** The survey of one lens. */
export type LensSurvey = { lens: string } & Survey

/** The development intake has route fields that a research program does not have, so the research intake has its own tool. */
const submitResearchIntake: Contracts.HostTool = {
  name: 'submit_research_intake',
  description:
    'Submit the intake one time: a title of the program, your summary of the program, a slug, and your open questions, each with a level by D11.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short title of the program, at most 72 characters' },
      summary: { type: 'string', description: 'The research question, the data that it needs, the result that answers it, and the calibrated null' },
      slug: { type: 'string', description: 'Lowercase words joined with hyphens, at most 40 characters, for example quiet-dwarf-search' },
      questions: questionsSchema,
    },
    required: ['title', 'summary', 'slug', 'questions'],
    additionalProperties: false,
  },
}

function checkResearchIntake(input: unknown): ResearchIntake {
  const intake = input as ResearchIntake
  const problems = [
    ...(!intake?.title?.trim() || intake.title.length > 72 ? ['title must have 1 to 72 characters'] : []),
    ...(!intake?.summary?.trim() ? ['summary is required'] : []),
    ...(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(intake?.slug ?? '') || intake.slug.length > 40 ? ['slug must be lowercase words joined with hyphens, at most 40 characters'] : []),
  ]
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { title: intake.title, summary: intake.summary, slug: intake.slug, questions: checkQuestions({ questions: intake.questions }) }
}

/** The egress of a role with egress: true. Web search runs at the provider, outside the holdout lock (RG10). */
export function researchEgress(domain: ResearchDomain): Egress {
  const { egress, credentials } = domain.config
  return { hosts: egress, web_search: true, ...(credentials ? { credentials } : {}) }
}

/** The notebook (at the base commit, or the tree of the run branch) and the run store, for the claim checks. */
function researchSources(context: ResearchContext, tree: FileSystem.FileSystem = context.tree): ResearchSources {
  const fs = readOnly(guard(tree))
  return {
    async read(path) {
      try {
        return new TextDecoder().decode(await fs.read(`/${path}`))
      } catch {
        return null
      }
    },
    artifact: async (id) => (context.host.egress ? context.host.egress.artifacts.get(id) : null),
  }
}

/**
 * One research agent: /repo (by default a read-only view of the base tree), /review, /guides and /artifacts. A role with
 * egress gets the egress of the domain, and its shell gets the same host fetch as its cells. The domain guides come after the role guides.
 */
async function agent(
  context: ResearchContext,
  id: string,
  role: Role,
  model: ModelChoice,
  review: Record<string, string>,
  tools: HostTools,
  repo: FileSystem.FileSystem = readOnly(guard(context.tree)),
): Promise<AgentSpec> {
  const egress = role.egress ? researchEgress(context.domain) : undefined
  const workspace = await createWorkspace({
    repo,
    review: { '/program.md': context.program, ...decisionsFile(context.host.ledger), ...review },
    guides: context.guides.mounts,
    ...(context.host.egress ? { artifacts: context.host.egress.artifacts } : {}),
    ...(egress ? { fetch: hostFetch(id, egress, context.host) } : {}),
  })
  const roleText = instructions(role, { read: context.guides.read, stackGuides: [] })
  const domainGuides = Object.keys(context.domain.guides)
    .sort()
    .map((name) => context.domain.guides[name]!.trim())
  return { id, ...model, instructions: [roleText, ...domainGuides].join('\n\n'), tools, workspace, turnMs: role.turnMs, ...(egress ? { egress } : {}) }
}

/** The input lines that every prompt starts with. */
const inputs = (context: ResearchContext, notebook = 'at the base commit') => [
  '- The program: /review/program.md',
  ...decisionsLine(decisionsFile(context.host.ledger)),
  `- The notebook: /repo, ${notebook}`,
]

/** Stage 0: reads the program and the notebook, and gives the summary and the open questions. */
export async function researchIntake(context: ResearchContext, id: string, model: ModelChoice): Promise<ResearchIntake> {
  const tools = submitOnce(context.host, `output:${id}`, submitResearchIntake, async (input) => checkResearchIntake(input))
  const prompt = [
    'Read this new research program and the notebook. No work starts before the user confirms the program.',
    '',
    ...inputs(context),
    '- The domain config: the research field of /repo/.agent-factory.json',
    `- The survey lenses: ${context.domain.config.lenses.survey.join(', ')}`,
    '',
    'Call submit_research_intake one time.',
  ].join('\n')
  return runTurn(context.host, await agent(context, id, researchRoles.intake, model, {}, tools), prompt, 'submit_research_intake')
}

/** The rejected submits after which a survey stops the run. The first rejection gives the surveyor one more try. */
const surveyTries = 2

/**
 * Stage 1: one surveyor on one lens. The ledger counts the rejected submits, so that a resume keeps the count.
 * At the second rejection, or when the turn ends without an accepted survey, the run stops and names the lens.
 * A check in progress holds a try, so that parallel submits do not get more tries.
 */
export async function survey(context: ResearchContext, id: string, model: ModelChoice, lens: string): Promise<LensSurvey> {
  const { ledger } = context.host
  const rejectedKey = `rejected:${id}`
  const rejected = () => ledger.get<number>(rejectedKey) ?? 0
  const failed = () => new StopError(`the survey of lens "${lens}" failed its claim check ${surveyTries} times`)
  if (rejected() >= surveyTries) throw failed()
  const sources = researchSources(context)
  let checking = 0
  const tools = submitOnce(context.host, `output:${id}`, submitSurvey, async (input) => {
    if (rejected() >= surveyTries) throw new Error(`the host rejected ${surveyTries} surveys, and the run stops`)
    if (rejected() + checking >= surveyTries) throw new Error('the host checks your other submit_survey calls. Wait for their result.')
    checking++
    try {
      return { lens, ...(await checkSurvey(input, sources)) }
    } catch (error) {
      ledger.put(rejectedKey, rejected() + 1)
      throw error
    } finally {
      checking--
    }
  })
  // After the last rejection, the run stops before runTurn opens a nudge turn.
  const host = {
    ...context.host,
    beforeTurn: async () => {
      if (rejected() >= surveyTries) throw failed()
      await context.host.beforeTurn?.()
    },
  }
  const prompt = [
    `Survey the lens "${lens}" for this program.`,
    '',
    ...inputs(context),
    '- The run store: /artifacts. The egress keeps each response there, and gives its ID in the x-artifact-id header.',
    '',
    `Call submit_survey one time. After a rejected call, you get one more try. At rejection ${surveyTries}, the run stops.`,
  ].join('\n')
  try {
    return await runTurn<LensSurvey>(host, await agent(context, id, researchRoles.surveyor, model, {}, tools), prompt, 'submit_survey')
  } catch (error) {
    if (rejected() >= surveyTries) throw failed()
    if (error instanceof Error && error.message === `${id} did not call submit_survey`) throw new StopError(`the surveyor of lens "${lens}" ended without an accepted survey`)
    throw error
  }
}

/** The surveys as one Markdown file, for the generators and the preregistrars. */
function renderSurveys(surveys: LensSurvey[]): string {
  return [
    '# Surveys',
    '',
    ...surveys.flatMap((entry) => [
      `## Lens: ${entry.lens}`,
      '',
      entry.summary.trim(),
      '',
      ...entry.claims.map((claim) => `- ${claim.statement.trim()} (${claim.location}: "${claim.evidence.trim()}")`),
      '',
    ]),
  ].join('\n')
}

/** Stage 2: one generator with all the surveys. */
export async function generate(context: ResearchContext, id: string, model: ModelChoice, surveys: LensSurvey[]): Promise<{ hypotheses: Hypothesis[] }> {
  const tools = submitOnce(context.host, `output:${id}`, submitHypotheses, async (input) => checkHypotheses(input))
  const prompt = [
    'Make hypotheses for this program from the surveys.',
    '',
    ...inputs(context),
    '- The surveys: /review/surveys.md',
    '- The run store: /artifacts',
    '',
    'Call submit_hypotheses one time.',
  ].join('\n')
  const spec = await agent(context, id, researchRoles.generator, model, { '/surveys.md': renderSurveys(surveys) }, tools)
  return runTurn(context.host, spec, prompt, 'submit_hypotheses')
}

function renderHypothesis(hypothesis: NumberedHypothesis): string {
  return [
    `# ${hypothesis.id}: ${hypothesis.title}`,
    '',
    `- Statement: ${hypothesis.statement}`,
    `- Why past work missed it: ${hypothesis.why_missed}`,
    `- Data: ${hypothesis.data}`,
    `- Test: ${hypothesis.test}`,
    `- Kill criterion: ${hypothesis.kill_criterion}`,
    `- Cost: ${hypothesis.cost}`,
    '',
  ].join('\n')
}

/**
 * Stage 4: the offline preregistrar of one picked hypothesis. It reads only that hypothesis. After a rejection by the
 * user, the same agent gets a new turn with the reason, under its own request ID and output key.
 */
export async function preregister(
  context: ResearchContext,
  model: ModelChoice,
  hypothesis: NumberedHypothesis,
  surveys: LensSurvey[],
  revision?: { round: number; reason: string },
): Promise<Prereg> {
  const id = `prereg.${hypothesis.id}`
  const turn = revision ? { request: `revise-${revision.round}`, key: `output:${id}:revise-${revision.round}` } : { request: 'task', key: `output:${id}` }
  const sections = context.domain.config.prereg_sections
  const tools = submitOnce(context.host, turn.key, submitPrereg, async (input) => checkPrereg(input, { picked: [hypothesis.id], domainSections: sections }))
  const review = {
    '/hypothesis.md': renderHypothesis(hypothesis),
    '/surveys.md': renderSurveys(surveys),
    '/prereg-sections.txt': [...coreSections, ...sections].join('\n'),
  }
  const prompt = [
    revision ? `The user rejected your prereg of ${hypothesis.id}. Write it again. The reason of the user: ${revision.reason}` : `Write the prereg of ${hypothesis.id}.`,
    '',
    ...inputs(context),
    '- The hypothesis: /review/hypothesis.md',
    '- The surveys: /review/surveys.md',
    '- The required sections: /review/prereg-sections.txt',
    '',
    'Call submit_prereg one time.',
  ].join('\n')
  return runTurn(context.host, await agent(context, id, researchRoles.preregistrar, model, review, tools), prompt, 'submit_prereg', turn)
}

/** A frozen prereg on the run branch. The freeze record of the workflow fits this type. */
export type FrozenRef = { hypothesis: string; path: string }

/** The calibration that the host gives the vet agents: the gate numbers and the artifact IDs of the command outputs. */
export type CalibrationSummary = { round: number; recall: number; threshold: number; known: string[]; inject: string[]; outputs: Record<string, string> }

/** A failed calibration round, for the fix turn of the builder. `tail` is the end of the command output. */
export type CalibrationFailure = { round: number; reason: string; tail: string }

/** An objection as a skeptic submits it, before the host gives it an ID. */
export type SkepticObjection = Omit<Objection, 'id'>

/** One vet round of one hypothesis: the objections of its skeptics, and the analyst responses or null before them. */
export type VetRound = { objections: Objection[]; responses: Responses | null }

/** The answer of the user to one held objection. */
export type HeldAnswer = { objection: string; answer: string }

const analysisDir = (hypothesis: string) => `analysis/${hypothesis}/`
const branchNotebook = 'on the run branch, with the analysis'

/** The notebook config for the analysis steps and the review of the analysis: prereg/ and dossier/ are host files. */
export function analysisConfig(config: RepoConfig): RepoConfig {
  return { ...config, protect: [...new Set([...(config.protect ?? []), 'prereg/', 'dossier/'])] }
}

const preregText = async (branch: Branch, prereg: FrozenRef) => new TextDecoder().decode(await branch.tree.read(`/${prereg.path}`))

function renderCalibration(hypothesis: string, calibration: CalibrationSummary): string {
  return [
    `# Calibration of ${hypothesis}`,
    '',
    `- Round: ${calibration.round}`,
    `- Known recall: ${calibration.recall} (threshold ${calibration.threshold})`,
    `- Known output artifacts: ${calibration.known.join(', ') || 'none'}`,
    `- Inject output artifacts: ${calibration.inject.join(', ') || 'none'}`,
    ...Object.entries(calibration.outputs).map(([path, id]) => `- Output file ${path}: artifact:${id}`),
    '',
  ].join('\n')
}

/** The line of the analyst response to one objection, or null when the analyst did not answer yet. */
export function responseLine(id: string, responses: Responses | null): string | null {
  const addressed = responses?.addressed.find((entry) => entry.id === id)
  if (addressed) return `Addressed: ${addressed.change.trim()} (artifacts: ${addressed.artifacts.join(', ')})`
  const conceded = responses?.conceded.find((entry) => entry.id === id)
  return conceded ? `Conceded: ${conceded.reason.trim()}` : null
}

/** The objections of each round with the analyst response and the user answer, for the late skeptics and the writer. */
function renderVet(rounds: VetRound[], answers: HeldAnswer[] = []): string {
  return [
    '# Objections',
    '',
    ...rounds.flatMap((round, index) => [
      `## Round ${index + 1}`,
      '',
      ...(round.objections.length === 0 ? ['No objections.', ''] : []),
      ...round.objections.flatMap((objection) => {
        const response = responseLine(objection.id, round.responses)
        const answer = answers.find((entry) => entry.objection === objection.id)
        return [
          `### ${objection.id}: ${objection.title} (${objection.severity}, lens ${objection.lens})`,
          '',
          `- Location: ${objection.location}`,
          `- Evidence: ${objection.evidence}`,
          `- Trigger: ${objection.trigger}`,
          `- Impact: ${objection.impact}`,
          `- Recommendation: ${objection.recommendation}`,
          ...(response ? [`- Analyst: ${response}`] : []),
          ...(answer ? [`- User: ${answer.answer}`] : []),
          '',
        ]
      }),
    ]),
  ].join('\n')
}

/**
 * Numbers the objections of one vet round across its skeptics, in skeptic order and then list order: obj-001 and up in
 * round 1, late-001 and up in round 2. Thus the IDs of one hypothesis are unique. The host ID replaces a submitted id field.
 */
export function numberObjections(lists: SkepticObjection[][], round: 1 | 2): Objection[] {
  const prefix = round === 1 ? 'obj' : 'late'
  return lists.flat().map((objection, index) => ({ ...objection, id: `${prefix}-${String(index + 1).padStart(3, '0')}` }))
}

export type AnalysisTask = {
  model: ModelChoice
  branch: Branch
  prereg: FrozenRef
  /** The notebook config. The step adds prereg/ and dossier/ to its protect entries. */
  config: RepoConfig
  active: Profile[]
  checker: Checker
  /** The commit that the analysis started from, for run_checks and the targeted tests. */
  base: string
  /** The failed calibration round that this fix turn answers. Without it, the turn is the first build. */
  failure?: CalibrationFailure
}

/** Stage 5: the builder writes only analysis/<id>/ of one prereg. Each calibration fix round is a new turn of the same agent. */
export async function buildAnalysis(context: ResearchContext, task: AnalysisTask): Promise<BuildLog> {
  const { hypothesis, path } = task.prereg
  const id = `build.${hypothesis}`
  const failure = task.failure
  const turn = failure ? { request: `fix-${failure.round}`, key: `output:${id}:fix-${failure.round}` } : { request: 'task', key: `output:${id}` }
  const develop: DevelopContext = { host: context.host, config: analysisConfig(task.config), guides: context.guides, stackGuides: [], ask: context.program }
  const { known, inject } = context.domain.config.commands
  const review = {
    '/program.md': context.program,
    '/prereg.md': await preregText(task.branch, task.prereg),
    ...(failure ? { '/calibration-failure.txt': `${failure.reason}\n\n--- end of the output ---\n${failure.tail}` } : {}),
  }
  const prompt = [
    failure
      ? `Calibration round ${failure.round} of ${hypothesis} failed. Fix the analysis so that the known recall gets to the threshold of the prereg.`
      : `Build the analysis of ${hypothesis} from its frozen prereg.`,
    '',
    '- The program: /review/program.md',
    `- The frozen prereg: /review/prereg.md (${path} in /repo)`,
    ...(failure ? ['- The calibration failure: /review/calibration-failure.txt, with the reason and the end of the output'] : []),
    `- The notebook: /repo, ${branchNotebook}. You can write only in ${analysisDir(hypothesis)}. prereg/ and dossier/ are protected.`,
    `- After your build, the host runs these domain commands with {prereg} as ${path}: known (${known}) and inject (${inject}).`,
    '  The last line of each output is JSON. known gives {"recall": <0 to 1>, "outputs": {"<path>": "<sha256>"}}, inject gives {"outputs": {...}}.',
    '',
    'Checkpoint your work, then call submit_build_log one time.',
  ].join('\n')
  return build(develop, {
    id,
    turn,
    model: task.model,
    branch: task.branch,
    scope: [analysisDir(hypothesis)],
    active: task.active,
    checker: task.checker,
    base: task.base,
    review,
    prompt,
    label: `agent-factory: analysis ${hypothesis}`,
  })
}

/** What each vet agent reads of one hypothesis. */
export type VetTask = { branch: Branch; prereg: FrozenRef; calibration: CalibrationSummary }

/** The review files that each vet agent gets. The program and the decisions come from agent(). */
const vetReview = async (task: VetTask) => ({
  '/prereg.md': await preregText(task.branch, task.prereg),
  '/calibration.md': renderCalibration(task.prereg.hypothesis, task.calibration),
})

const vetInputs = (context: ResearchContext) => [
  ...inputs(context, branchNotebook),
  '- The frozen prereg: /review/prereg.md',
  '- The calibration: /review/calibration.md',
  '- The run store: /artifacts',
]

/** One skeptic turn on one lens, offline, in a read-only workspace on the run branch. */
async function objections(
  context: ResearchContext,
  id: string,
  role: Role,
  model: ModelChoice,
  task: VetTask & { lens: string },
  extra: { review: Record<string, string>; lines: string[]; ask: string },
): Promise<{ objections: SkepticObjection[] }> {
  const sources = researchSources(context, task.branch.tree)
  const tools = submitOnce(context.host, `output:${id}`, submitObjections, (input) => checkObjections(input, sources, [task.lens]))
  const prompt = [extra.ask, '', ...vetInputs(context), ...extra.lines, '', `Use the lens "${task.lens}". Call submit_objections one time.`].join('\n')
  const spec = await agent(context, id, role, model, { ...(await vetReview(task)), ...extra.review }, tools, readOnly(guard(task.branch.tree)))
  return runTurn(context.host, spec, prompt, 'submit_objections')
}

/** Stage 9: a context-free skeptic. It reads the prereg, the analysis and the calibration, never the text of the analyst. */
export function skeptic(context: ResearchContext, id: string, model: ModelChoice, task: VetTask & { lens: string }): Promise<{ objections: SkepticObjection[] }> {
  const ask = `Examine the analysis of ${task.prereg.hypothesis} and find what is incorrect in it.`
  return objections(context, id, researchRoles.skeptic, model, task, { review: {}, lines: [], ask })
}

/** Stage 9: a late skeptic, as the skeptic, plus the first-round objections and the analyst responses. */
export function lateSkeptic(
  context: ResearchContext,
  id: string,
  model: ModelChoice,
  task: VetTask & { lens: string; first: VetRound },
): Promise<{ objections: SkepticObjection[] }> {
  return objections(context, id, researchRoles['late-skeptic'], model, task, {
    review: { '/first-round.md': renderVet([task.first]) },
    lines: ['- The objections of the first skeptics and the analyst responses: /review/first-round.md'],
    ask: `Examine what the analyst responses added to the analysis of ${task.prereg.hypothesis}.`,
  })
}

export type AnalystTask = VetTask & {
  /** The notebook config. The step adds prereg/ and dossier/ to its protect entries. */
  config: RepoConfig
  /** 1 answers the first skeptics, 2 the late skeptics, as a new turn of the same agent. */
  round: 1 | 2
  objections: Objection[]
}

/**
 * Stage 9: the analyst answers the objections of one round. It can write only analysis/<id>/, and the host commits.
 * `changed` tells the host that the analysis changed, so that the host commits it and runs the calibration again.
 */
export async function analyst(context: ResearchContext, model: ModelChoice, task: AnalystTask): Promise<{ responses: Responses; changed: boolean }> {
  const { hypothesis } = task.prereg
  const id = `analyst.${hypothesis}`
  const turn = task.round === 1 ? { request: 'task', key: `output:${id}` } : { request: 'late', key: `output:${id}:late` }
  const scope = [analysisDir(hypothesis)]
  const config = analysisConfig(task.config)
  const repo = allowFiles(guard(task.branch.tree, (path) => isProtected(config, path)), (path) => inScope(path, scope))
  const sources = researchSources(context, task.branch.tree)
  const tools = submitOnce(context.host, turn.key, submitResponses, (input) => checkResponses(input, task.objections, sources))
  const review = { ...(await vetReview(task)), '/objections.md': renderVet([{ objections: task.objections, responses: null }]) }
  const prompt = [
    `Answer the objections of the ${task.round === 1 ? 'skeptics' : 'late skeptics'} on the analysis of ${hypothesis}.`,
    '',
    ...vetInputs(context),
    '- The objections: /review/objections.md',
    '',
    `You can write only in ${analysisDir(hypothesis)}. prereg/ is protected. The host commits your changes and runs the calibration again.`,
    'The host asks the user about each conceded critical or high objection. Call submit_responses one time.',
  ].join('\n')
  const spec = await agent(context, id, researchRoles.analyst, model, review, tools, repo)
  const responses = await runTurn<Responses>(context.host, spec, prompt, 'submit_responses', turn)
  const pending = await task.branch.pending()
  return { responses, changed: [...pending.changed, ...pending.removed].some((path) => inScope(path, scope)) }
}

export type WriterTask = VetTask & { rounds: VetRound[]; answers: HeldAnswer[] }

/**
 * Stage 11: the writer of the dossier of one hypothesis, read-only on the run branch. Besides checkDossier, the
 * completeness and the false positives each cite an artifact of the final inject output (decision 2).
 */
export async function writeDossier(context: ResearchContext, model: ModelChoice, task: WriterTask): Promise<Dossier> {
  const { hypothesis } = task.prereg
  const id = `writer.${hypothesis}`
  const inject = task.calibration.inject
  const sources = researchSources(context, task.branch.tree)
  const tools = submitOnce(context.host, `output:${id}`, submitDossier, async (input) => {
    const dossier = await checkDossier(input, sources, context.domain.checklist)
    const uncited = (['completeness', 'false_positives'] as const).filter((field) => !dossier[field].some((artifact) => inject.includes(artifact)))
    if (uncited.length > 0) throw new Error(uncited.map((field) => `${field} must cite at least one inject output artifact: ${inject.join(', ')}`).join('\n'))
    return dossier
  })
  const review = { ...(await vetReview(task)), '/objections.md': renderVet(task.rounds, task.answers) }
  const prompt = [
    `Write the dossier of ${hypothesis}. The host writes dossier/${hypothesis}.md from it.`,
    '',
    ...vetInputs(context),
    '- The objections, the analyst responses and the user answers: /review/objections.md',
    '',
    `Cite at least one inject output artifact (${inject.join(', ') || 'none'}) in completeness and in false_positives. Call submit_dossier one time.`,
  ].join('\n')
  const spec = await agent(context, id, researchRoles.writer, model, review, tools, readOnly(guard(task.branch.tree)))
  return runTurn(context.host, spec, prompt, 'submit_dossier')
}

/** The conceded objections of all rounds, in round order, with the reason of the analyst. */
export function conceded(rounds: VetRound[]): { objection: Objection; reason: string }[] {
  return rounds.flatMap((round) =>
    round.objections.flatMap((objection) => {
      const entry = round.responses?.conceded.find((item) => item.id === objection.id)
      return entry ? [{ objection, reason: entry.reason }] : []
    }),
  )
}

/** dossier/<id>.md, from the dossier and the vet record. The same input always gives the same text. */
export function renderDossier(hypothesis: string, dossier: Dossier, rounds: VetRound[], answers: HeldAnswer[] = []): string {
  const kept = conceded(rounds)
  const artifacts = (ids: string[]) => ids.map((id) => `- artifact:${id}`)
  return [
    `# Dossier ${hypothesis}`,
    '',
    `- Outcome: ${dossier.outcome}`,
    `- Trials: ${dossier.trials}`,
    '',
    '## Summary',
    '',
    dossier.summary.trim(),
    '',
    '## Claims',
    '',
    ...(dossier.claims.length === 0 ? ['None.'] : dossier.claims.map((claim) => `- ${claim.statement.trim()} (${claim.location}: "${claim.evidence.trim()}")`)),
    '',
    '## Checklist',
    '',
    ...dossier.checklist.map((entry) => `- ${entry.item}: ${entry.status}${entry.location ? ` (${entry.location}: "${(entry.evidence ?? '').trim()}")` : ''}`),
    '',
    '## Completeness',
    '',
    ...artifacts(dossier.completeness),
    '',
    '## False positives',
    '',
    ...artifacts(dossier.false_positives),
    '',
    '## Coverage',
    '',
    dossier.coverage.trim(),
    '',
    '## Reproduce',
    '',
    '```sh',
    dossier.reproduce.trim(),
    '```',
    '',
    '## Conceded objections',
    '',
    ...(kept.length === 0
      ? ['None.']
      : kept.map(({ objection, reason }) => {
          const answer = answers.find((entry) => entry.objection === objection.id)
          return `- ${objection.id} (${objection.severity}, lens ${objection.lens}): ${objection.title}. ${objection.location}. Reason: ${reason.trim()}${answer ? ` User: ${answer.answer}` : ''}`
        })),
    '',
  ].join('\n')
}
