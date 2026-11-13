import type { Contracts } from 'nanocode-ts'

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
}

export type Checked = { findings: Submitted[]; errors: [] } | { findings: []; errors: string[] }

/** Enforces the evidence rule: every finding needs a trigger, an impact, and a quote that the reviewer read. */
export async function checkFindings(input: unknown, sources: Sources): Promise<Checked> {
  const list = (input as { findings?: unknown } | null)?.findings
  if (!Array.isArray(list)) return { findings: [], errors: ['findings must be an array'] }
  const errors: string[] = []
  const findings: Submitted[] = []
  for (const [index, item] of list.entries()) {
    const problems = await checkFinding(item as Record<string, unknown>, sources)
    if (problems.length > 0) errors.push(...problems.map((problem) => `findings[${index}]: ${problem}`))
    else findings.push(normalizeLocation(item as Submitted))
  }
  return errors.length > 0 ? { findings: [], errors } : { findings, errors: [] }
}

async function checkFinding(item: Record<string, unknown>, sources: Sources): Promise<string[]> {
  const missing = fields.filter((field) => typeof item[field] !== 'string' || (item[field] as string).trim() === '')
  if (missing.length > 0) return [`missing ${missing.join(', ')}`]
  const finding = item as Submitted
  if (!severities.includes(finding.severity)) return [`severity must be one of ${severities.join(', ')}`]

  const location = parseLocation(finding.location)
  if (!location) return [`location "${finding.location}" is not path:line or path:start-end`]
  const file = await sources.read(location.path)
  if (file === null) return [`location "${finding.location}": ${location.path} does not exist in the reviewed tree`]

  const lines = file.split('\n')
  if (location.start > lines.length) return [`location "${finding.location}": the file has ${lines.length} lines`]
  const window = squash(
    lines.slice(Math.max(0, location.start - 1 - evidenceWindowLines), location.end + evidenceWindowLines).join('\n'),
  )
  const fragments = finding.evidence
    .split(/\.\.\.|…/)
    .map((fragment) => squash(stripLineNumbers(fragment)))
    .filter((fragment) => fragment.length > 0)
  if (fragments.length === 0) return ['evidence has no quoted code']
  const short = fragments.filter((fragment) => fragment.replace(/\s/g, '').length < minEvidenceChars)
  if (short.length > 0) return short.map((fragment) => `evidence "${fragment}" is too short: quote at least ${minEvidenceChars} non-space characters of code`)
  const diff = squash(stripDiffMarkers(fileDiff(sources.diff, location.path)))
  const unmatched = fragments.filter((fragment) => !window.includes(fragment) && !diff.includes(fragment))
  return unmatched.map(
    (fragment) => `evidence "${fragment}" is not in ${location.path} near line ${location.start}, or in its diff. Quote code that you read.`,
  )
}

export function parseLocation(location: string): { path: string; start: number; end: number } | null {
  const match = /^(?:\/repo\/)?(.+?):(\d+)(?:-(\d+))?$/.exec(location.trim())
  if (!match) return null
  const start = Number(match[2])
  const end = match[3] ? Number(match[3]) : start
  return start > 0 && end >= start ? { path: match[1]!.replace(/^\.\//, ''), start, end } : null
}

function normalizeLocation(finding: Submitted): Submitted {
  const location = parseLocation(finding.location)!
  const lines = location.end === location.start ? `${location.start}` : `${location.start}-${location.end}`
  return { ...finding, location: `${location.path}:${lines}` }
}

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
