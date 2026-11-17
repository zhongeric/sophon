import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { hostFetch, runTurn, submitOnce, type AgentHost, type AgentSpec, type HostTools } from './agent.ts'
import { checkHypotheses, checkSurvey, submitHypotheses, submitSurvey, type Hypothesis, type NumberedHypothesis, type ResearchSources, type Survey } from './claims.ts'
import type { Egress } from './egress.ts'
import type { Guides } from './platform.ts'
import { checkPrereg, coreSections, submitPrereg, type Prereg } from './prereg.ts'
import { checkQuestions, decisionsFile, decisionsLine, questionsSchema, type Question } from './questions.ts'
import type { ResearchDomain } from './research.ts'
import { instructions, researchRoles, type ModelChoice, type Role } from './roles.ts'
import { StopError } from './stop.ts'
import { createWorkspace, guard, readOnly } from './workspace.ts'

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

/** The notebook at the base commit and the run store, for the claim checks. */
function researchSources(context: ResearchContext): ResearchSources {
  const fs = readOnly(guard(context.tree))
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
 * One research agent: a read-only workspace on the base tree, /review, /guides and /artifacts. A role with egress gets
 * the egress of the domain, and its shell gets the same host fetch as its cells. The domain guides come after the role guides.
 */
async function agent(context: ResearchContext, id: string, role: Role, model: ModelChoice, review: Record<string, string>, tools: HostTools): Promise<AgentSpec> {
  const egress = role.egress ? researchEgress(context.domain) : undefined
  const workspace = await createWorkspace({
    repo: readOnly(guard(context.tree)),
    review: { '/program.md': context.program, ...decisionsFile(context.host.ledger), ...review },
    guides: context.guides.mounts,
    ...(context.host.egress ? { artifacts: context.host.egress.artifacts } : {}),
    ...(egress ? { fetch: hostFetch(id, egress, context.host) } : {}),
  })
  const roleText = instructions(role, { read: context.guides.read, stackGuides: [] })
  const domainGuides = Object.keys(context.domain.guides)
    .sort()
    .map((name) => context.domain.guides[name]!.trim())
  return { id, ...model, instructions: [roleText, ...domainGuides].join('\n\n'), tools, workspace, ...(egress ? { egress } : {}) }
}

/** The input lines that every prompt starts with. */
const inputs = (context: ResearchContext) => ['- The program: /review/program.md', ...decisionsLine(decisionsFile(context.host.ledger)), '- The notebook: /repo, at the base commit']

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
