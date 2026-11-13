import type { Contracts } from 'nanocode-ts'
import type { Track } from './findings.ts'
import type { Provider } from './providers.ts'

export type RoleId =
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

/** What one specialized agent reads (its guidelines) and may do (its rails). */
export type Role = {
  id: RoleId
  /** Guideline files under agents/, in order. */
  guides: string[]
  /** Appended when the change touches Solidity. */
  solidityGuide: boolean
  /** Reviewers report findings under this track, with IDs like `<prefix>-001`. */
  findings?: { track: Track; prefix: string }
  /** Gets the run_tests tool. */
  tests: boolean
}

const reviewer = ['shared/factory.md', 'shared/reviewer.md']

export const roles: Record<RoleId, Role> = {
  minimize: { id: 'minimize', guides: [...reviewer, 'minimize.md'], solidityGuide: false, findings: { track: 'minimize', prefix: 'min' }, tests: false },
  rules: { id: 'rules', guides: [...reviewer, 'rules.md', 'shared/ste.md'], solidityGuide: true, findings: { track: 'rules', prefix: 'rules' }, tests: false },
  bugs: { id: 'bugs', guides: [...reviewer, 'bugs.md'], solidityGuide: true, findings: { track: 'bugs', prefix: 'bugs' }, tests: true },
  'anti-slop': {
    id: 'anti-slop',
    guides: [...reviewer, 'anti-slop.md', 'shared/ste.md'],
    solidityGuide: false,
    findings: { track: 'anti-slop', prefix: 'anti' },
    tests: false,
  },
  'late-minimize': {
    id: 'late-minimize',
    guides: [...reviewer, 'minimize.md', 'late-pass.md'],
    solidityGuide: false,
    findings: { track: 'minimize', prefix: 'late-min' },
    tests: false,
  },
  'late-rules': {
    id: 'late-rules',
    guides: [...reviewer, 'rules.md', 'late-pass.md', 'shared/ste.md'],
    solidityGuide: true,
    findings: { track: 'rules', prefix: 'late-rules' },
    tests: false,
  },
  'late-bugs': {
    id: 'late-bugs',
    guides: [...reviewer, 'bugs.md', 'late-pass.md'],
    solidityGuide: true,
    findings: { track: 'bugs', prefix: 'late-bugs' },
    tests: true,
  },
  patch: { id: 'patch', guides: ['shared/factory.md', 'patch.md', 'shared/ste.md'], solidityGuide: true, tests: true },
  intent: { id: 'intent', guides: ['shared/factory.md', 'intent.md'], solidityGuide: false, tests: false },
  questions: { id: 'questions', guides: ['shared/factory.md', 'questions.md'], solidityGuide: false, tests: false },
}

/** Every guideline file that some role reads, relative to agents/. */
export const guideFiles = [...new Set([...Object.values(roles).flatMap((role) => role.guides), 'shared/solidity.md'])]

/** The developer instructions of one agent: its role line, then its guideline files. */
export function instructions(role: Role, options: { solidity: boolean; read(file: string): string }): string {
  const files = [...role.guides, ...(role.solidityGuide && options.solidity ? ['shared/solidity.md'] : [])]
  return [`Agent role: ${role.id}`, ...files.map((file) => options.read(file).trim())].join('\n\n')
}

export type ModelChoice = { provider: Provider; model: string; thinking?: Contracts.Thinking }
