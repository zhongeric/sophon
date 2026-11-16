import type { Contracts } from 'nanocode-ts'
import { isArtifactId } from './artifacts.ts'
import { isRule, rules, type Rule } from './questions.ts'

export const severities = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof severities)[number]
export type Track = 'minimize' | 'rules' | 'bugs' | 'anti-slop' | 'intent'

export type Finding = {
  id: string
  track: Track
  location: string
  title: string
  trigger: string
  impact: string
  severity: Severity
  evidence: string
  recommendation: string
  /** The right fix depends on a product or design choice that only the user can make. */
  needs_decision?: boolean
  /** That choice, in one sentence. Required with needs_decision. */
  decision?: string
  /** The D11 rule that makes the choice the user's. Required with needs_decision. */
  rule?: Rule
}

type Submitted = Omit<Finding, 'id' | 'track'>

const fields = ['location', 'title', 'trigger', 'impact', 'severity', 'evidence', 'recommendation'] as const

/** Lines around a finding's location where its evidence quote may appear. */
const evidenceWindowLines = 20
/** Non-space characters that each evidence fragment needs, so that a stray token such as \`}\` is not a quote. */
const minEvidenceChars = 8

export const submitFindings: Contracts.HostTool = {
  name: 'submit_findings',
  description:
    'Submit your review findings, one time, at the end of the review. Submit an empty list when you have no findings. ' +
    'The host checks each finding: the location must be an existing file and line, and each evidence fragment must have at least 8 non-space characters and appear in that file near that line, or in the diff of that file. ' +
    'A rejected call lists every problem; fix them and call again.',
  parameters: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'path:line or path:start-end, relative to /repo, for example src/Vault.sol:88' },
            title: { type: 'string', description: 'Short imperative title' },
            trigger: { type: 'string', description: 'The input or state that causes the issue' },
            impact: { type: 'string', description: 'What breaks, leaks, costs, or confuses' },
            severity: { type: 'string', enum: [...severities] },
            evidence: { type: 'string', description: 'A short code quote that you read at the location. Join separate fragments with ...' },
            recommendation: { type: 'string', description: 'A concrete fix direction' },
            needs_decision: {
              type: 'boolean',
              description:
                'True only when the right fix depends on a choice that the ask and the decisions leave open, and that choice is the user\'s by a D11 rule. It needs that rule in rule',
            },
            decision: { type: 'string', description: 'With needs_decision: the choice that the user must make, in one sentence' },
            rule: {
              type: 'string',
              enum: [...rules],
              description:
                'With needs_decision: the D11 rule. scope: the choice removes or adds scope compared with the ask. capability: it changes capabilities across workflows. spend: it commits spend over the budget or an irreversible or public action. decision: it departs from a recorded D or RD row',
            },
          },
          required: [...fields],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
}

export type Sources = {
  /** Reads a file of the reviewed tree, or returns null when it does not exist. */
  read(path: string): Promise<string | null>
  /** The reviewed diff. */
  diff: string
  /** Reads an artifact of the run store, or returns null for an unknown ID. Without it, an artifact location is an error. */
  artifact?(id: string): Promise<Uint8Array | null>
}

export type Checked = { findings: Submitted[]; errors: [] } | { findings: []; errors: string[] }

/** Enforces the evidence rule: every finding needs a trigger, an impact, and a quote that the reviewer read. */
export async function checkFindings(input: unknown, sources: Sources): Promise<Checked> {
  const list = (input as { findings?: unknown } | null)?.findings
  if (!Array.isArray(list)) return { findings: [], errors: ['findings must be an array'] }
  const errors: string[] = []
  const findings: Submitted[] = []
  const check = evidenceChecker(sources)
  for (const [index, item] of list.entries()) {
    const problems = await checkFinding(item as Record<string, unknown>, check)
    if (problems.length > 0) errors.push(...problems.map((problem) => `findings[${index}]: ${problem}`))
    else findings.push(normalizeLocation(item as Submitted))
  }
  return errors.length > 0 ? { findings: [], errors } : { findings, errors: [] }
}

async function checkFinding(item: Record<string, unknown>, check: EvidenceCheck): Promise<string[]> {
  const missing = fields.filter((field) => typeof item[field] !== 'string' || (item[field] as string).trim() === '')
  if (missing.length > 0) return [`missing ${missing.join(', ')}`]
  const finding = item as Submitted
  if (!severities.includes(finding.severity)) return [`severity must be one of ${severities.join(', ')}`]
  if (finding.needs_decision && !finding.decision?.trim()) return ['needs_decision needs the decision, in one sentence']
  if (finding.needs_decision && !isRule(finding.rule)) return [`needs_decision needs a D11 rule: ${rules.join(', ')}`]
  return check(finding)
}

/** A location and the quote that the agent read there. */
export type Evidence = { location: string; evidence: string }
export type EvidenceCheck = (item: Evidence) => Promise<string[]>

/**
 * Makes the evidence check for one submit call: it gives the problems of one location and its quote, with the messages of submit_findings.
 * Make a new check for each call, because the check keeps each artifact that it read until the call ends.
 */
export function evidenceChecker(sources: Sources): EvidenceCheck {
  const artifacts = sources.artifact && artifactReader(sources.artifact.bind(sources))
  return async (item) => {
    const location = parseLocation(item.location)
    if (!location) {
      // List the artifact forms only when this review can read artifacts, so that a code reviewer uses file locations.
      const forms = artifacts ? artifactLocationForms : 'path:line or path:start-end'
      return [`location "${item.location}" is not ${forms}`]
    }
    return 'path' in location ? checkFileEvidence(item, location, sources) : checkArtifactEvidence(item, location, artifacts)
  }
}

async function checkFileEvidence(finding: Evidence, location: FileLocation, sources: Sources): Promise<string[]> {
  const file = await sources.read(location.path)
  if (file === null) {
    if (sources.artifact && location.path.startsWith('artifact:')) {
      return [`location "${finding.location}" is not ${artifactLocationForms}`]
    }
    return [`location "${finding.location}": ${location.path} does not exist in the reviewed tree`]
  }
  const lines = file.split('\n')
  if (location.start > lines.length) return [`location "${finding.location}": the file has ${lines.length} lines`]
  const diff = squash(stripDiffMarkers(fileDiff(sources.diff, location.path)))
  return checkEvidence(
    finding.evidence,
    [evidenceWindow(lines, location), diff],
    'code',
    (fragment) => `evidence "${fragment}" is not in ${location.path} near line ${location.start}, or in its diff. Quote code that you read.`,
  )
}

/** The diff is not a source for an artifact quote, because an artifact is not in the reviewed tree. */
async function checkArtifactEvidence(finding: Evidence, location: ArtifactLocation, artifacts: ArtifactReader | undefined): Promise<string[]> {
  const { artifact: id, lines: range } = location
  if (!artifacts) return [`location "${finding.location}": this review has no artifact store`]
  const text = await artifacts(id)
  if (text === 'unknown') return [`location "${finding.location}": artifact ${id} does not exist in the run store`]
  if (text === 'binary') return [`location "${finding.location}": artifact ${id} is binary, and the evidence check reads only UTF-8 text`]
  if (!range) {
    const unmatched = (fragment: string) => `evidence "${fragment}" is not in artifact ${id}. Quote text that you read.`
    return checkEvidence(finding.evidence, [text.squashed()], 'text', unmatched)
  }
  const lines = text.lines()
  if (range.start > lines.length) return [`location "${finding.location}": the artifact has ${lines.length} lines`]
  return checkEvidence(
    finding.evidence,
    [evidenceWindow(lines, range)],
    'text',
    (fragment) => `evidence "${fragment}" is not in artifact ${id} near line ${range.start}. Quote text that you read.`,
  )
}

/**
 * Checks each fragment of an evidence quote: it must be long enough and appear in one of the squashed texts.
 * A fragment matches with its line-number gutters removed, or as it is.
 * The rows of a table can start with a number and a pipe.
 * The noun is the thing that the reviewer quotes: code or text.
 */
function checkEvidence(evidence: string, texts: string[], noun: string, unmatched: (fragment: string) => string): string[] {
  const fragments = evidence
    .split(/\.\.\.|…/)
    .map((fragment) => ({ stripped: squash(stripLineNumbers(fragment)), raw: squash(fragment) }))
    .filter(({ raw }) => raw.length > 0)
  if (fragments.length === 0) return [`evidence has no quoted ${noun}`]
  const long = (form: string) => form.replace(/\s/g, '').length >= minEvidenceChars
  const found = (form: string) => long(form) && texts.some((text) => text.includes(form))
  const failed = fragments.filter(({ stripped, raw }) => !found(stripped) && !found(raw))
  const short = failed.filter(({ stripped, raw }) => !long(stripped) && !long(raw))
  if (short.length > 0) {
    return short.map(({ raw }) => `evidence "${raw}" is too short: quote at least ${minEvidenceChars} non-space characters of ${noun}`)
  }
  return failed.map(({ stripped, raw }) => unmatched(long(stripped) ? stripped : raw))
}

/** The squashed lines around a line range, where its evidence quote may appear. */
function evidenceWindow(lines: string[], range: LineRange): string {
  return squash(lines.slice(Math.max(0, range.start - 1 - evidenceWindowLines), range.end + evidenceWindowLines).join('\n'))
}

/** The text of an artifact, with its lines and its squashed form calculated only when a location needs them. */
type ArtifactText = { lines(): string[]; squashed(): string }
type ArtifactEntry = ArtifactText | 'unknown' | 'binary'
type ArtifactReader = (id: string) => Promise<ArtifactEntry>

/** Reads and decodes each artifact one time for each submit call, because many findings can cite the same large artifact. */
function artifactReader(read: (id: string) => Promise<Uint8Array | null>): ArtifactReader {
  const cache = new Map<string, Promise<ArtifactEntry>>()
  const load = async (id: string): Promise<ArtifactEntry> => {
    const bytes = await read(id)
    if (bytes === null) return 'unknown'
    const text = utf8Text(bytes)
    if (text === null) return 'binary'
    let lines: string[] | undefined
    let squashed: string | undefined
    return { lines: () => (lines ??= text.split('\n')), squashed: () => (squashed ??= squash(text)) }
  }
  return (id) => {
    const entry = cache.get(id) ?? load(id)
    cache.set(id, entry)
    return entry
  }
}

/** The text of artifact bytes, or null when the bytes are not strict UTF-8 or contain a NUL character. The check does not use the media_type. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    // ignoreBOM: false is the default, but the Workers types require the field.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

/** Lines from start to end, both included. */
type LineRange = { start: number; end: number }
type FileLocation = { path: string } & LineRange
/** An artifact of the run store, by its ID. Without lines, the evidence quote can be anywhere in the artifact. */
type ArtifactLocation = { artifact: string; lines: LineRange | null }

const artifactLocation = /^artifact:([^:]+)(?::(\d+)(?:-(\d+))?)?$/
const artifactLocationForms = 'path:line, path:start-end, artifact:<id>, artifact:<id>:line or artifact:<id>:start-end'

/** A location with the "artifact:" prefix and no valid artifact ID is a file location, so that a file such as "artifact:notes.md" stays a source. */
export function parseLocation(location: string): FileLocation | ArtifactLocation | null {
  const text = location.trim()
  const [, id = '', start, end] = artifactLocation.exec(text) ?? []
  if (isArtifactId(id)) {
    if (start === undefined) return { artifact: id, lines: null }
    const lines = lineRange(start, end)
    return lines && { artifact: id, lines }
  }
  const match = /^(?:\/repo\/)?(.+?):(\d+)(?:-(\d+))?$/.exec(text)
  if (!match) return null
  const lines = lineRange(match[2]!, match[3])
  return lines && { path: match[1]!.replace(/^\.\//, ''), ...lines }
}

/** The line range of a location, or null when it does not start after line 0 or ends before its start. */
function lineRange(start: string, end: string | undefined): LineRange | null {
  const first = Number(start)
  const last = end ? Number(end) : first
  return first > 0 && last >= first ? { start: first, end: last } : null
}

function normalizeLocation(finding: Submitted): Submitted {
  const location = parseLocation(finding.location)!
  if ('path' in location) return { ...finding, location: `${location.path}:${lineText(location)}` }
  const lines = location.lines ? `:${lineText(location.lines)}` : ''
  return { ...finding, location: `artifact:${location.artifact}${lines}` }
}

const lineText = (range: LineRange) => (range.end === range.start ? `${range.start}` : `${range.start}-${range.end}`)

/** Removes the line-number gutters that file-reading tools add, such as "  88\t" or "88→". */
function stripLineNumbers(text: string): string {
  return text.replace(/^\s*\d+(?:\t|→|│|\|)/gm, '')
}

/** The section of a git diff for one file, by its path after the change. */
function fileDiff(diff: string, path: string): string {
  return diff.split(/^(?=diff --git )/m).find((section) => section.split('\n', 1)[0]!.endsWith(` b/${path}`)) ?? ''
}

/** Removes the +, - and space markers of diff lines, so that a quote of changed code matches. */
function stripDiffMarkers(diff: string): string {
  return diff
    .split('\n')
    .map((line) => (/^[+\- ]/.test(line) && !/^(?:\+\+\+|---) /.test(line) ? line.slice(1) : line))
    .join('\n')
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Gives each finding a stable ID, for example bugs-003, from its role prefix and position. */
export function assignIds(findings: Submitted[], track: Track, prefix: string): Finding[] {
  return findings.map((finding, index) => ({ id: `${prefix}-${String(index + 1).padStart(3, '0')}`, track, ...finding }))
}
