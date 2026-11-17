import type { Contracts } from 'nanocode-ts'
import type { Track } from './findings.ts'
import { profiles } from './profiles.ts'
import type { Provider } from './providers.ts'

export type ReviewRoleId =
  | 'minimize'
  | 'rules'
  | 'bugs'
  | 'anti-slop'
  | 'late-minimize'
  | 'late-rules'
  | 'late-bugs'
  | 'patch'
  | 'intent'
  | 'questions'
  | 'light'

export type DevelopRoleId = 'intake' | 'spec' | 'planner' | 'builder'

export type ResearchRoleId = 'intake' | 'surveyor' | 'generator' | 'preregistrar' | 'skeptic' | 'late-skeptic' | 'analyst' | 'writer' | 'builder'

/** What one specialized agent reads (its guidelines) and may do (its rails). */
export type Role<Id extends string = string> = {
  id: Id
  /** Guideline files under agents/, in order. */
  guides: string[]
  /** Gets the guides of the profiles that govern the changed files, for example profiles/solidity.md. */
  stackGuides: boolean
  /** Reviewers report findings under this track, with IDs like `<prefix>-001`. */
  findings?: { track: Track; prefix: string }
  /** Gets the run_tests tool. */
  tests: boolean
  /** When true, the role may get the egress of the domain. When false, the role stays offline. */
  egress: boolean
  /** The nanocode subagents of the role. Without this field, the role gets no subagents. */
  subagents?: SubagentLimit | 'unlimited'
}

/** The limits of the subagents of one root turn. `tokens` counts the input and output tokens of the subagents only. */
export type SubagentLimit = { concurrent: number; perTurn: number; tokens: number }

/** RD1 of the research spec: the host bounds the subagents of a research role. */
const researchSubagents: SubagentLimit = { concurrent: 3, perTurn: 6, tokens: 2_000_000 }

/** One workflow's roles: each key is the id of its role. */
export type RoleTable<Id extends string> = { [Key in Id]: Role<Key> }

const reviewer = ['shared/factory.md', 'shared/reviewer.md']

export const reviewRoles: RoleTable<ReviewRoleId> = {
  minimize: {
    id: 'minimize',
    guides: [...reviewer, 'minimize.md'],
    stackGuides: false,
    findings: { track: 'minimize', prefix: 'min' },
    tests: false,
    egress: false,
  },
  rules: {
    id: 'rules',
    guides: [...reviewer, 'rules.md', 'shared/ste.md'],
    stackGuides: true,
    findings: { track: 'rules', prefix: 'rules' },
    tests: false,
    egress: false,
  },
  bugs: { id: 'bugs', guides: [...reviewer, 'bugs.md'], stackGuides: true, findings: { track: 'bugs', prefix: 'bugs' }, tests: true, egress: false },
  'anti-slop': {
    id: 'anti-slop',
    guides: [...reviewer, 'anti-slop.md', 'shared/ste.md'],
    stackGuides: false,
    findings: { track: 'anti-slop', prefix: 'anti' },
    tests: false,
    egress: false,
  },
  'late-minimize': {
    id: 'late-minimize',
    guides: [...reviewer, 'minimize.md', 'late-pass.md'],
    stackGuides: false,
    findings: { track: 'minimize', prefix: 'late-min' },
    tests: false,
    egress: false,
  },
  'late-rules': {
    id: 'late-rules',
    guides: [...reviewer, 'rules.md', 'late-pass.md', 'shared/ste.md'],
    stackGuides: true,
    findings: { track: 'rules', prefix: 'late-rules' },
    tests: false,
    egress: false,
  },
  'late-bugs': {
    id: 'late-bugs',
    guides: [...reviewer, 'bugs.md', 'late-pass.md'],
    stackGuides: true,
    findings: { track: 'bugs', prefix: 'late-bugs' },
    tests: true,
    egress: false,
  },
  patch: { id: 'patch', guides: ['shared/factory.md', 'patch.md', 'shared/ste.md'], stackGuides: true, tests: true, egress: false },
  intent: { id: 'intent', guides: ['shared/factory.md', 'intent.md'], stackGuides: false, tests: false, egress: false },
  questions: { id: 'questions', guides: ['shared/factory.md', 'questions.md'], stackGuides: false, tests: false, egress: false },
  light: { id: 'light', guides: ['shared/factory.md', 'light.md', 'anti-slop.md', 'shared/ste.md'], stackGuides: true, tests: true, egress: false },
}

export const developRoles: RoleTable<DevelopRoleId> = {
  intake: { id: 'intake', guides: ['shared/factory.md', 'intake.md'], stackGuides: false, tests: false, egress: false },
  spec: { id: 'spec', guides: ['shared/factory.md', 'spec.md', 'shared/ste.md'], stackGuides: false, tests: false, egress: false },
  planner: { id: 'planner', guides: ['shared/factory.md', 'planner.md', 'shared/ste.md'], stackGuides: true, tests: false, egress: false },
  builder: {
    id: 'builder',
    guides: ['shared/factory.md', 'builder.md', 'shared/ste.md'],
    stackGuides: true,
    tests: true,
    egress: false,
    subagents: 'unlimited',
  },
}

export const researchRoles: RoleTable<ResearchRoleId> = {
  intake: { id: 'intake', guides: ['shared/factory.md', 'research/intake.md'], stackGuides: false, tests: false, egress: true },
  surveyor: {
    id: 'surveyor',
    guides: ['shared/factory.md', 'research/surveyor.md'],
    stackGuides: false,
    tests: false,
    egress: true,
    subagents: researchSubagents,
  },
  generator: { id: 'generator', guides: ['shared/factory.md', 'research/generator.md'], stackGuides: false, tests: false, egress: true },
  preregistrar: {
    id: 'preregistrar',
    guides: ['shared/factory.md', 'research/preregistrar.md', 'shared/ste.md'],
    stackGuides: false,
    tests: false,
    egress: false,
  },
  skeptic: { id: 'skeptic', guides: ['shared/factory.md', 'research/skeptic.md'], stackGuides: false, tests: false, egress: false },
  'late-skeptic': {
    id: 'late-skeptic',
    guides: ['shared/factory.md', 'research/skeptic.md', 'research/late-skeptic.md'],
    stackGuides: false,
    tests: false,
    egress: false,
  },
  analyst: {
    id: 'analyst',
    guides: ['shared/factory.md', 'research/analyst.md', 'shared/ste.md'],
    stackGuides: true,
    tests: true,
    egress: true,
    subagents: researchSubagents,
  },
  writer: { id: 'writer', guides: ['shared/factory.md', 'research/writer.md', 'shared/ste.md'], stackGuides: false, tests: false, egress: false },
  builder: developRoles.builder,
}

/** Every guideline file that some role or profile reads, relative to agents/. */
export const guideFiles = [
  ...new Set([
    ...[reviewRoles, developRoles, researchRoles].flatMap((table) => Object.values<Role>(table).flatMap((role) => role.guides)),
    ...profiles.flatMap((profile) => profile.guides),
  ]),
]

/** The developer instructions of one agent: its role line, then its guideline files. */
export function instructions(role: Role, options: { stackGuides: string[]; read(file: string): string }): string {
  const files = [...role.guides, ...(role.stackGuides ? options.stackGuides : [])]
  return [`Agent role: ${role.id}`, ...files.map((file) => options.read(file).trim())].join('\n\n')
}

export type ModelChoice = { provider: Provider; model: string; thinking?: Contracts.Thinking }
