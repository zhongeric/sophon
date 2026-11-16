import type { Contracts } from 'nanocode-ts'
import { isArtifactId } from './artifacts.ts'
import { evidenceChecker, severities, type Evidence, type EvidenceCheck, type Severity } from './findings.ts'

/** What the research checks read. The host gives the domain data and the stores. The checks never read the config. */
export type ResearchSources = {
  /** Reads a file of the notebook, or returns null when it does not exist. */
  read(path: string): Promise<string | null>
  /** Reads an artifact of the run store, or returns null for an unknown ID. */
  artifact(id: string): Promise<Uint8Array | null>
}

/** A statement with a location and the quote that the agent read there. */
export type Claim = { statement: string; location: string; evidence: string }
export type Survey = { summary: string; claims: Claim[] }

export type Hypothesis = { title: string; statement: string; why_missed: string; data: string; test: string; kill_criterion: string; cost: string }
/** A hypothesis after the merge, with its host ID, for example hyp-003. */
export type NumberedHypothesis = Hypothesis & { id: string }

export type Objection = {
  id: string
  lens: string
  location: string
  title: string
  trigger: string
  impact: string
  severity: Severity
  evidence: string
  recommendation: string
}
type SubmittedObjection = Omit<Objection, 'id'>

export type Responses = { addressed: { id: string; change: string; artifacts: string[] }[]; conceded: { id: string; reason: string }[] }

export const outcomes = ['candidate', 'null'] as const
export const checklistStatuses = ['ruled_out', 'open', 'not_tested'] as const
export type ChecklistStatus = (typeof checklistStatuses)[number]
/** A ruled_out item has a location and evidence. The other statuses do not need them. */
export type ChecklistEntry = { item: string; status: ChecklistStatus; location?: string; evidence?: string }

export type Dossier = {
  outcome: (typeof outcomes)[number]
  summary: string
  claims: Claim[]
  checklist: ChecklistEntry[]
  completeness: string[]
  false_positives: string[]
  coverage: string
  trials: number
  /** The command line that reproduces the result. The host keeps it as text and does not run it here. */
  reproduce: string
}

const locationText = 'artifact:<id>, artifact:<id>:line, artifact:<id>:start-end, or a notebook path:line relative to /repo'
const evidenceText = 'A short quote that you read at the location. Join separate fragments with ...'
const evidenceRule =
  'The host checks each location and evidence: the artifact must exist in the run store and be UTF-8 text, or the notebook file and line must exist, and each evidence fragment must have at least 8 non-space characters and appear near that line, or anywhere in an artifact without a line. '
const rejected = 'A rejected call lists every problem. Fix them and call again.'

const text = (description?: string) => (description ? { type: 'string', description } : { type: 'string' })
const ids = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })

const claimSchema = object({ statement: text('One claim, in one or two sentences'), location: text(locationText), evidence: text(evidenceText) })
const claimFields = ['statement', 'location', 'evidence'] as const

export const submitSurvey: Contracts.HostTool = {
  name: 'submit_survey',
  description: 'Submit your survey of your lens one time: a summary and the claims that you found. Give at least one claim. ' + evidenceRule + rejected,
  parameters: object({ summary: text('What you found, in a few sentences'), claims: { type: 'array', items: claimSchema } }),
}

const hypothesisFields = ['title', 'statement', 'why_missed', 'data', 'test', 'kill_criterion', 'cost'] as const

export const submitHypotheses: Contracts.HostTool = {
  name: 'submit_hypotheses',
  description:
    'Submit your hypotheses one time. Each hypothesis needs every field as non-empty text. Submit an empty list when you have no hypothesis. ' +
    'The host removes a hypothesis with the same data and test as an earlier one, and gives the IDs. ' +
    rejected,
  parameters: object({
    hypotheses: {
      type: 'array',
      items: object({
        title: text('Short title'),
        statement: text('The hypothesis, in one or two sentences'),
        why_missed: text('Why past work missed it'),
        data: text('The data that the test uses'),
        test: text('The test that decides it'),
        kill_criterion: text('The result that kills the hypothesis'),
        cost: text('The cost of the test, for example in compute, time or data access'),
      }),
    },
  }),
}

const objectionFields = ['lens', 'location', 'title', 'trigger', 'impact', 'severity', 'evidence', 'recommendation'] as const

export const submitObjections: Contracts.HostTool = {
  name: 'submit_objections',
  description:
    'Submit your objections one time. Submit an empty list when you have no objection. Each objection needs every field, and lens must be one of the lenses that your prompt gives. ' +
    evidenceRule +
    rejected,
  parameters: object({
    objections: {
      type: 'array',
      items: object({
        lens: text('Your skeptic lens, exactly as your prompt gives it'),
        location: text(locationText),
        title: text('Short imperative title'),
        trigger: text('The data, method or step that causes the problem'),
        impact: text('What the problem does to the result'),
        severity: { type: 'string', enum: [...severities] },
        evidence: text(evidenceText),
        recommendation: text('A concrete fix direction'),
      }),
    },
  }),
}

export const submitResponses: Contracts.HostTool = {
  name: 'submit_responses',
  description:
    'Record your answer to the objections. List every objection ID exactly one time: in addressed, with the change and the IDs of the artifacts that show it, or in conceded, with the reason. ' +
    'Each addressed objection needs at least one artifact ID, and each ID must exist in the run store. ' +
    rejected,
  parameters: object({
    addressed: { type: 'array', items: object({ id: text(), change: text('What you changed'), artifacts: ids('IDs of the artifacts that show the change') }) },
    conceded: { type: 'array', items: object({ id: text(), reason: text('Why the objection stays') }) },
  }),
}

export const submitDossier: Contracts.HostTool = {
  name: 'submit_dossier',
  description:
    'Submit the dossier one time. A candidate needs at least one claim. A null can have no claims. ' +
    'Give each item of the domain checklist exactly one status, with the item text exactly as the checklist gives it. A ruled_out item needs a location and evidence. ' +
    'Give at least one completeness artifact ID and one false-positive artifact ID, each in the run store. trials is an integer of 1 or more. ' +
    evidenceRule +
    rejected,
  parameters: object({
    outcome: { type: 'string', enum: [...outcomes] },
    summary: text('The result, in a few sentences'),
    claims: { type: 'array', items: claimSchema },
    checklist: {
      type: 'array',
      items: object(
        {
          item: text('The checklist item, exactly as the checklist gives it'),
          status: { type: 'string', enum: [...checklistStatuses] },
          location: text(`With ruled_out: ${locationText}`),
          evidence: text(`With ruled_out: ${evidenceText}`),
        },
        ['item', 'status'],
      ),
    },
    completeness: ids('IDs of the completeness artifacts'),
    false_positives: ids('IDs of the false-positive artifacts'),
    coverage: text('What the search covered and what it did not cover'),
    trials: { type: 'integer', minimum: 1, description: 'The count of trials' },
    reproduce: text('The command line that reproduces the result'),
  }),
}

type Fields = Record<string, unknown>

const record = (value: unknown): Fields => (typeof value === 'object' && value !== null ? (value as Fields) : {})
const filled = (value: unknown) => typeof value === 'string' && value.trim() !== ''
const absentFields = (item: Fields, fields: readonly string[]) => fields.filter((field) => !filled(item[field]))
/** The fields that are not non-empty text, as one problem, or no problem. */
const missing = (item: Fields, fields: readonly string[]) => {
  const names = absentFields(item, fields)
  return names.length > 0 ? [`missing ${names.join(', ')}`] : []
}
const prefixed = (prefix: string, problems: string[]) => problems.map((problem) => `${prefix}: ${problem}`)

/** Rejects one time with every problem, so that the agent can fix all of them in the next call. */
function reject(problems: string[]): void {
  if (problems.length > 0) throw new Error(problems.join('\n'))
}

/** The evidence check of submit_findings, on the notebook and the run store. A research check has no diff. */
function researchChecker(sources: ResearchSources): EvidenceCheck {
  return evidenceChecker({ read: (path) => sources.read(path), diff: '', artifact: (id) => sources.artifact(id) })
}

/** The problems of each claim, with its index. */
async function checkClaims(list: unknown[], check: EvidenceCheck): Promise<string[]> {
  const problems: string[] = []
  for (const [index, value] of list.entries()) {
    const claim = record(value)
    const absent = missing(claim, claimFields)
    problems.push(...prefixed(`claims[${index}]`, absent.length > 0 ? absent : await check(claim as Claim)))
  }
  return problems
}

/** Refuses a survey without a summary, without claims, or with a claim that fails the evidence check. */
export async function checkSurvey(input: unknown, sources: ResearchSources): Promise<Survey> {
  const survey = record(input)
  const problems = missing(survey, ['summary'])
  if (!Array.isArray(survey.claims)) problems.push('claims must be an array')
  else if (survey.claims.length === 0) problems.push('claims is empty: give at least one claim')
  else problems.push(...(await checkClaims(survey.claims, researchChecker(sources))))
  reject(problems)
  return survey as Survey
}

export async function checkHypotheses(input: unknown): Promise<{ hypotheses: Hypothesis[] }> {
  const list = record(input).hypotheses
  if (!Array.isArray(list)) throw new Error('hypotheses must be an array')
  reject(list.flatMap((value, index) => prefixed(`hypotheses[${index}]`, missing(record(value), hypothesisFields))))
  return { hypotheses: list as Hypothesis[] }
}

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
const numbered = (prefix: string, index: number) => `${prefix}-${String(index + 1).padStart(3, '0')}`

/**
 * Merges the lists of the generators, in generator order, then list order. A hypothesis with the same data and test
 * as an earlier one, without case and with whitespace collapsed, is a duplicate. The IDs have no gaps.
 */
export function mergeHypotheses(lists: Hypothesis[][]): NumberedHypothesis[] {
  const seen = new Set<string>()
  const kept = lists.flat().filter((hypothesis) => {
    const key = JSON.stringify([normalize(hypothesis.data), normalize(hypothesis.test)])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return kept.map((hypothesis, index) => ({ id: numbered('hyp', index), ...hypothesis }))
}

/** Enforces the evidence rule on objections, with a lens of the domain in place of a review track. */
export async function checkObjections(input: unknown, sources: ResearchSources, lenses: string[]): Promise<{ objections: SubmittedObjection[] }> {
  const list = record(input).objections
  if (!Array.isArray(list)) throw new Error('objections must be an array')
  const check = researchChecker(sources)
  const problems: string[] = []
  for (const [index, value] of list.entries()) {
    const objection = record(value)
    const absent = missing(objection, objectionFields)
    if (absent.length > 0) {
      problems.push(...prefixed(`objections[${index}]`, absent))
      continue
    }
    const { lens, severity } = objection as SubmittedObjection
    const own = [
      ...(severities.includes(severity) ? [] : [`severity must be one of ${severities.join(', ')}`]),
      ...(lenses.includes(lens) ? [] : [`lens "${lens}" is not one of ${lenses.join(', ')}`]),
      ...(await check(objection as SubmittedObjection)),
    ]
    problems.push(...prefixed(`objections[${index}]`, own))
  }
  reject(problems)
  return { objections: list as SubmittedObjection[] }
}

/** Gives each objection a stable ID, for example obj-003, from its position in the submitted list. */
export function assignObjectionIds(objections: SubmittedObjection[]): Objection[] {
  return objections.map((objection, index) => ({ id: numbered('obj', index), ...objection }))
}

/** The problems of a list of artifact IDs: it must not be empty, and each ID must be valid and in the run store. */
async function checkArtifactIds(value: unknown, field: string, sources: ResearchSources): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0) return [`${field} needs at least one artifact ID`]
  const problems: string[] = []
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !isArtifactId(id)) problems.push(`${field}[${index}]: ${JSON.stringify(id)} is not an artifact ID`)
    else if ((await sources.artifact(id)) === null) problems.push(`${field}[${index}]: artifact ${id} does not exist in the run store`)
  }
  return problems
}

/** Checks that the responses list every objection one time, as checkPatchLog does, and that each change cites artifacts. */
export async function checkResponses(input: unknown, objections: { id: string }[], sources: ResearchSources): Promise<Responses> {
  const responses = record(input)
  const { addressed, conceded } = responses
  if (!Array.isArray(addressed) || !Array.isArray(conceded)) throw new Error('addressed and conceded must be arrays')
  const problems: string[] = []
  for (const [index, value] of addressed.entries()) {
    const entry = record(value)
    const own = [...missing(entry, ['id', 'change']), ...(await checkArtifactIds(entry.artifacts, 'artifacts', sources))]
    problems.push(...prefixed(`addressed[${index}]`, own))
  }
  for (const [index, value] of conceded.entries()) problems.push(...prefixed(`conceded[${index}]`, missing(record(value), ['id', 'reason'])))
  const listed = [...addressed, ...conceded].map((entry) => record(entry).id).filter(filled) as string[]
  const expected = new Set(objections.map((objection) => objection.id))
  const unknown = listed.filter((id) => !expected.has(id))
  const repeated = listed.filter((id, index) => listed.indexOf(id) !== index)
  const absent = [...expected].filter((id) => !listed.includes(id))
  if (unknown.length) problems.push(`unknown objections: ${unknown.join(', ')}`)
  if (repeated.length) problems.push(`listed more than one time: ${repeated.join(', ')}`)
  if (absent.length) problems.push(`missing objections: ${absent.join(', ')}`)
  reject(problems)
  return responses as Responses
}

/** The problems of the checklist statuses: each item of the domain checklist exactly one time, and evidence for each ruled_out item. */
async function checkChecklist(value: unknown, checklist: string[], check: EvidenceCheck): Promise<string[]> {
  if (!Array.isArray(value)) return ['checklist must be an array']
  const problems: string[] = []
  for (const [index, raw] of value.entries()) {
    const entry = record(raw)
    const own = missing(entry, ['item'])
    if (own.length === 0 && !checklist.includes(entry.item as string)) own.push(`unknown checklist item "${entry.item}"`)
    if (!checklistStatuses.includes(entry.status as ChecklistStatus)) own.push(`status must be one of ${checklistStatuses.join(', ')}`)
    else if (entry.status === 'ruled_out') {
      const absent = absentFields(entry, ['location', 'evidence'])
      own.push(...(absent.length > 0 ? [`ruled_out needs ${absent.join(' and ')}`] : await check(entry as Evidence)))
    }
    problems.push(...prefixed(`checklist[${index}]`, own))
  }
  const items = value.map((entry) => record(entry).item)
  for (const item of checklist) {
    const count = items.filter((listed) => listed === item).length
    if (count === 0) problems.push(`checklist item "${item}" has no status`)
    if (count > 1) problems.push(`checklist item "${item}" is listed more than one time`)
  }
  return problems
}

/** Refuses a dossier that does not say what it found, what it ruled out, and how to reproduce it. */
export async function checkDossier(input: unknown, sources: ResearchSources, checklist: string[]): Promise<Dossier> {
  const dossier = record(input)
  const check = researchChecker(sources)
  const problems = missing(dossier, ['summary', 'coverage', 'reproduce'])
  if (!outcomes.includes(dossier.outcome as Dossier['outcome'])) problems.push(`outcome must be one of ${outcomes.join(', ')}`)
  if (!Array.isArray(dossier.claims)) problems.push('claims must be an array')
  else {
    if (dossier.outcome === 'candidate' && dossier.claims.length === 0) problems.push('a candidate needs at least one claim')
    problems.push(...(await checkClaims(dossier.claims, check)))
  }
  problems.push(...(await checkChecklist(dossier.checklist, checklist, check)))
  problems.push(...(await checkArtifactIds(dossier.completeness, 'completeness', sources)))
  problems.push(...(await checkArtifactIds(dossier.false_positives, 'false_positives', sources)))
  if (!Number.isInteger(dossier.trials) || (dossier.trials as number) < 1) problems.push('trials must be an integer of 1 or more')
  reject(problems)
  return dossier as Dossier
}
