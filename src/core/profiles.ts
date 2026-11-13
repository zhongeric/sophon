import type { Finding, Severity } from './findings.ts'

/** A mechanical rule that the host checks on each line that a change adds, before any reviewer reads the change. */
export type StaticRule = {
  id: string
  /** True when the added line breaks the rule. `previous` is the line before it, or null when the diff does not show it. */
  breaks(line: string, previous: string | null): boolean
  title: string
  impact: string
  recommendation: string
  severity: Severity
}

/** One stack's rules, in one place. The workflows ask the matched profiles, and never branch on a stack. */
export type Profile = {
  id: string
  /** Files at the repository root that must all exist for the profile to apply, for example foundry.toml. */
  markers: string[]
  /** The changed files that the profile governs. Its static rules check these files. */
  files: RegExp
  /** The governed files that may take the light loop because they cannot change behavior, or null for none. */
  light: RegExp | null
  /** Guideline files under agents/, for the roles that judge or change code. */
  guides: string[]
  /** Paths that a change must not add or modify, for example build output. */
  forbidden: RegExp[]
  rules: StaticRule[]
}

/** A comment on the line, or on the line before it. An unknown line before counts as a comment, so that the rule does not guess. */
const commented = (line: string, previous: string | null) => /\/\/|\/\*/.test(line) || previous === null || /^\s*(\/\/|\/?\*)/.test(previous)

const testPrefix = '(?:test|testFuzz|testFork|invariant)_'
/** Plain `test_{action}_{scenario}`, or branching tree `test_{Function}_{WhenCondition}[_{WhenCondition}...]_{outcome}` (D9). */
const testNames = [
  new RegExp(`^${testPrefix}[a-z][A-Za-z0-9]*_[a-z][A-Za-z0-9]*$`),
  new RegExp(`^${testPrefix}[A-Z][A-Za-z0-9]*(_(When|Given)[A-Z][A-Za-z0-9]*)+_(succeeds|revertsWith[A-Z][A-Za-z0-9]*)$`),
]

const pragma: StaticRule = {
  id: 'sol-floating-pragma',
  breaks: (line) => /^\s*pragma\s+solidity\s*[\^><~]/.test(line),
  title: 'Pin the pragma to the version in foundry.toml',
  impact: 'A floating pragma lets a compiler version that the tests did not use compile the file',
  recommendation: 'Use the exact version that foundry.toml pins, for example `pragma solidity 0.8.28;`',
  severity: 'medium',
}

const namedImports: StaticRule = {
  id: 'sol-wildcard-import',
  breaks: (line) => /^\s*import\s+(?!\{)/.test(line),
  title: 'Use a named import',
  impact: 'A wildcard import brings every symbol of the file into scope, and hides where each name comes from',
  recommendation: 'Import only the names that the file uses: `import {Name} from "...";`',
  severity: 'low',
}

const solidityGuides = ['profiles/solidity.md']
const foundryOutput = [/^out\//, /^cache\//, /^broadcast\//]

const solidity: Profile = {
  id: 'solidity',
  markers: ['foundry.toml'],
  files: /^src\/.*\.sol$/,
  light: null,
  guides: solidityGuides,
  forbidden: foundryOutput,
  rules: [
    pragma,
    namedImports,
    {
      id: 'sol-revert-string',
      breaks: (line) => /\brequire\s*\(.*,\s*"|\brevert\s*\(\s*"/.test(line),
      title: 'Replace the revert string with a custom error',
      impact: 'A revert string costs more gas than a custom error, and breaks the custom error convention',
      recommendation: 'Declare a custom error in the interface, and use `if (...) revert ErrorName();`',
      severity: 'medium',
    },
    {
      id: 'sol-tx-origin',
      breaks: (line) => /\btx\.origin\b/.test(line),
      title: 'Do not use tx.origin',
      impact: 'Authorization with tx.origin lets a malicious contract act for each user who calls it',
      recommendation: 'Use msg.sender',
      severity: 'high',
    },
    {
      id: 'sol-selfdestruct',
      breaks: (line) => /\bselfdestruct\s*\(/.test(line),
      title: 'Remove selfdestruct',
      impact: 'selfdestruct is deprecated, and it can remove code that users and other contracts depend on',
      recommendation: 'Remove the call. If the contract must stop, add an explicit pause or shutdown path',
      severity: 'high',
    },
    {
      id: 'sol-unchecked-reason',
      breaks: (line, previous) => /\bunchecked\s*\{/.test(line) && !commented(line, previous),
      title: 'Give the reason for the unchecked block',
      impact: 'A reader cannot see why the arithmetic cannot overflow, so a later change can break that condition',
      recommendation: 'Add a comment on the line before the block that says why overflow is not possible',
      severity: 'low',
    },
    {
      id: 'sol-assembly-reason',
      breaks: (line, previous) => /\bassembly\b[^;]*\{/.test(line) && !commented(line, previous),
      title: 'Give the safety reason for the assembly block',
      impact: 'Inline assembly skips the compiler safety checks, and nothing tells a reader why the block is safe',
      recommendation: 'Add a comment on the line before the block that says why the block is safe',
      severity: 'low',
    },
  ],
}

/** Tests and scripts in a Foundry repository. Deploy scripts always get the full loop. */
const soliditySupport: Profile = {
  id: 'solidity-support',
  markers: ['foundry.toml'],
  files: /^(test|script)\/.*\.sol$/,
  light: /^test\//,
  guides: solidityGuides,
  forbidden: foundryOutput,
  rules: [
    pragma,
    namedImports,
    {
      id: 'sol-test-name',
      breaks(line) {
        const name = /\bfunction\s+((?:test|invariant)\w*)\s*\(/.exec(line)?.[1]
        return name !== undefined && !testNames.some((shape) => shape.test(name))
      },
      title: 'Rename the test to one of the two name shapes',
      impact: 'The name does not tell which action and scenario the test checks, and it breaks the naming convention',
      recommendation:
        'Use `test_{action}_{scenario}`, or for a branching tree `test_{Function}_{WhenCondition}[_{WhenCondition}...]_{succeeds|revertsWith{Error}}`. Fuzz, fork and invariant tests use the same shapes',
      severity: 'low',
    },
  ],
}

const typescript: Profile = {
  id: 'typescript',
  markers: ['package.json', 'tsconfig.json'],
  files: /\.[cm]?[jt]sx?$/,
  light: /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/,
  guides: ['profiles/typescript.md'],
  forbidden: [/(^|\/)node_modules\//],
  rules: [],
}

const docs: Profile = {
  id: 'docs',
  markers: [],
  files: /\.(mdx?|rst)$/i,
  light: /./,
  guides: [],
  forbidden: [],
  rules: [
    {
      id: 'docs-latin',
      breaks: (line) => /\b(e\.g|i\.e|etc)\./i.test(line),
      title: 'Replace the Latin abbreviation',
      impact: 'STE does not allow Latin abbreviations, and many readers do not know them',
      recommendation: 'Write "for example", "that is" or "and more", or give the full list',
      severity: 'low',
    },
  ],
}

export const profiles: Profile[] = [solidity, soliditySupport, typescript, docs]

/** Scratch logs and environment files, in every repository. */
const forbiddenEverywhere = [/\.log$/, /(^|\/)\.env(\.(?!(example|sample|template)$)[^/]+)?$/]

export const profilesById = (ids: string[]) => profiles.filter((profile) => ids.includes(profile.id))

/** A file may take the light loop only when a profile governs it, and every profile that governs it allows it. */
export function isLight(path: string, active: Profile[]): boolean {
  const governing = active.filter((profile) => profile.files.test(path))
  return governing.length > 0 && governing.every((profile) => profile.light?.test(path) ?? false)
}

/** The light or full loop for one change, with the profiles that apply to it. */
export type Triage = {
  path: 'light' | 'full'
  reason: 'docs-or-tests-only' | 'not-docs-or-tests' | 'empty-diff' | 'full-asked'
  /** With not-docs-or-tests: the files that need the full loop. */
  files: string[]
  /** The profiles whose markers exist. */
  profiles: string[]
  /** The guides of the profiles that govern a changed file. */
  guides: string[]
}

export async function triage(changed: string[], exists: (path: string) => Promise<boolean>, full: boolean): Promise<Triage> {
  const present: Profile[] = []
  for (const profile of profiles) if ((await Promise.all(profile.markers.map(exists))).every(Boolean)) present.push(profile)
  const governing = present.filter((profile) => changed.some((path) => profile.files.test(path)))
  const resolved = { profiles: present.map((profile) => profile.id), guides: [...new Set(governing.flatMap((profile) => profile.guides))] }
  const behavior = changed.filter((path) => !isLight(path, present))
  if (full) return { ...resolved, path: 'full', reason: 'full-asked', files: [] }
  if (changed.length === 0) return { ...resolved, path: 'full', reason: 'empty-diff', files: [] }
  if (behavior.length > 0) return { ...resolved, path: 'full', reason: 'not-docs-or-tests', files: behavior }
  return { ...resolved, path: 'light', reason: 'docs-or-tests-only', files: [] }
}

export function triageLine(result: Triage): string {
  const more = result.files.length > 5 ? `,+${result.files.length - 5}` : ''
  const files = result.files.length > 0 ? ` files=${result.files.slice(0, 5).join(',')}${more}` : ''
  return `TRIAGE path=${result.path} reason=${result.reason}${files} profiles=${result.profiles.join(',') || 'none'}`
}

/**
 * Checks each line that the diff adds against the rules of the profiles that govern its file, and each changed path
 * against the forbidden paths. The host quotes the line, so these findings skip the evidence check.
 */
export function staticFindings(diff: string, changed: string[], active: Profile[]): Omit<Finding, 'id' | 'track'>[] {
  const findings: Omit<Finding, 'id' | 'track'>[] = []
  const forbidden = [...forbiddenEverywhere, ...active.flatMap((profile) => profile.forbidden)]
  for (const path of changed.filter((path) => forbidden.some((pattern) => pattern.test(path))))
    findings.push({
      location: `${path}:1`,
      title: `Remove ${path} from the change`,
      trigger: 'the change adds or modifies this path',
      impact: 'Build output, scratch logs and environment files do not belong in the repository. Environment files can hold secrets',
      severity: /(^|\/)\.env/.test(path) ? 'high' : 'medium',
      evidence: path,
      recommendation: 'Remove the file from the change, and add its pattern to .gitignore',
    })

  let rules: StaticRule[] = []
  let path = ''
  let header = false
  let line = 0
  let previous: string | null = null
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      header = true
      rules = []
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      header = false
      line = Number(hunk[1])
      previous = null
      continue
    }
    if (header) {
      if (text.startsWith('+++ ')) {
        path = text.slice(4).replace(/^b\//, '')
        rules = active.filter((profile) => profile.files.test(path)).flatMap((profile) => profile.rules)
      }
      continue
    }
    if (text.startsWith('+')) {
      const content = text.slice(1)
      for (const rule of rules)
        if (rule.breaks(content, previous))
          findings.push({
            location: `${path}:${line}`,
            title: rule.title,
            trigger: `the change adds this line (host rule ${rule.id})`,
            impact: rule.impact,
            severity: rule.severity,
            evidence: content.trim(),
            recommendation: rule.recommendation,
          })
    }
    if (text.startsWith('+') || text.startsWith(' ')) {
      previous = text.slice(1)
      line++
    }
  }
  return findings
}
