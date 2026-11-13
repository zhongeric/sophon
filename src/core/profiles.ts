import type { RepoConfig } from './checks.ts'
import type { Finding, Severity } from './findings.ts'

/** The files at the root of a repository tree, where markers, manifests and lockfiles are. */
export type RootFiles = {
  exists(name: string): Promise<boolean>
  /** The text of a file, or null when it does not exist. */
  read(name: string): Promise<string | null>
}

/** A mechanical rule that the host checks on each line that a change adds, before any reviewer reads the change. */
export type StaticRule = {
  id: string
  /** True when the added line breaks the rule. `previous` is null when unknown. `source` has no comments. */
  breaks(line: string, previous: string | null, source: string): boolean
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
  /** Sections that a plan must have, beyond its four parts. */
  planSections: string[]
  /** The repository config of the stack, for each field that .agent-factory.json does not set. */
  defaults?(root: RootFiles): Promise<Partial<RepoConfig>>
}

/** A comment on the line, or on the line before it. An unknown line before counts as a comment, so that the rule does not guess. */
const commented = (line: string, previous: string | null) => /\/\/|\/\*/.test(line) || previous === null || /^\s*(\/\/|\/?\*)/.test(previous)

/** Remove comments outside string literals. Keep code after a closed block comment. */
const code = (line: string, blockComment: boolean) => {
  let source = ''
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i)
    if (blockComment) {
      if (line.startsWith('*/', i)) {
        blockComment = false
        i++
      }
    } else if (quote) {
      source += char
      if (char === '\\' && i + 1 < line.length) source += line.charAt(++i)
      else if (char === quote) quote = ''
    } else if (line.startsWith('//', i)) {
      break
    } else if (line.startsWith('/*', i)) {
      blockComment = true
      source += ' '
      i++
    } else if (line.startsWith('*/', i)) {
      source += ' '
      i++
    } else {
      source += char
      if (char === '"' || char === "'") quote = char
    }
  }
  return { source, blockComment }
}

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
  breaks: (line) => /^\s*import\b(?!\s*\{)/.test(line),
  title: 'Use a named import',
  impact: 'A wildcard import brings every symbol of the file into scope, and hides where each name comes from',
  recommendation: 'Import only the names that the file uses: `import {Name} from "...";`',
  severity: 'low',
}

const solidityGuides = ['profiles/solidity.md']
const foundryOutput = [/^out\//, /^cache\//, /^broadcast\//]

/** The Solidity rules for src/ files in a Foundry repository. */
const solidityRules: StaticRule[] = [
  pragma,
  namedImports,
  {
    id: 'sol-revert-string',
    breaks: (_line, _previous, source) => /\brequire\s*\(.*,\s*"|\brevert\s*\(\s*"/.test(source),
    title: 'Replace the revert string with a custom error',
    impact: 'A revert string costs more gas than a custom error, and breaks the custom error convention',
    recommendation: 'Declare a custom error in the interface, and use `if (...) revert ErrorName();`',
    severity: 'medium',
  },
  {
    id: 'sol-tx-origin',
    breaks: (_line, _previous, source) => /\btx\.origin\b/.test(source),
    title: 'Do not use tx.origin',
    impact: 'Authorization with tx.origin lets a malicious contract act for each user who calls it',
    recommendation: 'Use msg.sender',
    severity: 'high',
  },
  {
    id: 'sol-selfdestruct',
    breaks: (_line, _previous, source) => /\bselfdestruct\s*\(/.test(source),
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
]

const solidity: Profile = {
  id: 'solidity',
  markers: ['foundry.toml'],
  files: /^src\/.*\.sol$/,
  light: null,
  guides: solidityGuides,
  forbidden: foundryOutput,
  planSections: ['Interfaces', 'Deployment sequence'],
  rules: solidityRules,
  defaults: async (root) => ({
    stack: 'Solidity+Foundry',
    checks: { build: 'forge build', format: { command: 'forge fmt --check {files}', files: '\\.sol$' } },
    tests: { pattern: '\\.t\\.sol$', command: 'forge test --match-path {test}' },
    // Foundry dependencies are git submodules, and a new worktree does not have them.
    ...((await root.exists('.gitmodules')) ? { setup: 'forge install' } : {}),
    protect: ['foundry.toml', 'remappings.txt'],
  }),
}

/** Tests and scripts in a Foundry repository. Deploy scripts always get the full loop. */
const soliditySupport: Profile = {
  id: 'solidity-support',
  markers: ['foundry.toml'],
  files: /^(test|script)\/.*\.sol$/,
  light: /^test\//,
  guides: solidityGuides,
  forbidden: foundryOutput,
  planSections: [],
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

type PackageJson = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** The package manager that the lockfile at the root names: its lockfile, and its install, script and binary commands. */
async function packageManager(root: RootFiles) {
  if (await root.exists('pnpm-lock.yaml')) return { lockfile: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile', run: 'pnpm run', exec: 'pnpm exec' }
  if (await root.exists('yarn.lock'))
    return { lockfile: 'yarn.lock', install: (await root.exists('.yarnrc.yml')) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile', run: 'yarn run', exec: 'yarn' }
  if (await root.exists('package-lock.json')) return { lockfile: 'package-lock.json', install: 'npm ci --prefer-offline --no-audit --no-fund', run: 'npm run', exec: 'npx' }
  // Without a lockfile, the install must not write one: the host commits every new file of the tree.
  return { lockfile: null, install: 'npm install --no-package-lock --no-audit --no-fund', run: 'npm run', exec: 'npx' }
}

/** The script names that a repository uses for its typecheck, in order of preference. */
const typecheckScripts = ['typecheck', 'type-check', 'check-types', 'types']

const typescript: Profile = {
  id: 'typescript',
  markers: ['package.json', 'tsconfig.json'],
  files: /\.[cm]?[jt]sx?$/,
  /** Test directories only at the repository or package root, so that production code in a directory named test gets the full loop. */
  light: /^(packages\/[^/]+\/)?(test|tests)\/|(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/,
  guides: ['profiles/typescript.md'],
  forbidden: [],
  rules: [],
  planSections: [],
  async defaults(root) {
    let manifest: PackageJson = {}
    try {
      manifest = JSON.parse((await root.read('package.json')) ?? '{}') as PackageJson
    } catch {
      // A package.json that does not parse gives the defaults that need no scripts.
    }
    const scripts = manifest.scripts ?? {}
    const packages = { ...manifest.dependencies, ...manifest.devDependencies }
    const manager = await packageManager(root)
    const typecheck = typecheckScripts.find((name) => scripts[name])
    const runner = packages.vitest ? `${manager.exec} vitest run {tests}` : packages.jest ? `${manager.exec} jest {tests}` : null
    return {
      stack: 'TypeScript',
      checks: {
        typecheck: typecheck ? `${manager.run} ${typecheck}` : `${manager.exec} tsc --noEmit`,
        ...(packages.eslint ? { lint: { command: `${manager.exec} eslint {files}`, files: '\\.[cm]?[jt]sx?$' } } : {}),
      },
      ...(runner ? { tests: { pattern: '\\.(test|spec)\\.[cm]?[jt]sx?$', command: runner } } : {}),
      setup: manager.install,
      protect: ['package.json', 'tsconfig.json', ...(manager.lockfile ? [manager.lockfile] : [])],
    }
  },
}

const docs: Profile = {
  id: 'docs',
  markers: [],
  files: /\.(mdx?|rst)$/i,
  /** Agent prompts and repository rule files change the behavior of agents, so they always get the full loop. */
  light: /^(?!agents\/)(?!(.*\/)?(AGENTS\.md|CLAUDE\.md|CONTRIBUTING[^/]*)$)/i,
  guides: [],
  forbidden: [],
  planSections: [],
  rules: [
    {
      id: 'docs-latin',
      breaks: (line) => /\b(e\.g|i\.e|etc)\./i.test(line),
      title: 'Replace the Latin abbreviation',
      impact: 'STE does not allow Latin abbreviations, and many readers do not know them',
      recommendation: 'Write "for example", "that is" or "and so on", or give the full list',
      severity: 'low',
    },
  ],
}

export const profiles: Profile[] = [solidity, soliditySupport, typescript, docs]

/** Scratch logs and environment files, in every repository. */
const forbiddenEverywhere = [/\.log$/, /(^|\/)\.env(\.(?!(example|sample|template)$)[^/]+)?$/]

/** Paths that agents never write in any repository: the CI workflows, which run with the secrets of the repository. */
const protectedEverywhere = ['.github/']

/**
 * The repository config that the present profiles give, for each field that .agent-factory.json does not set.
 * Checks and protected paths are the union, the setup commands run in profile order, and the first profile with
 * tests gives the tests. Read it from the base of a change, so that a change cannot set its own rails.
 */
export async function profileDefaults(root: RootFiles): Promise<Partial<RepoConfig>> {
  const present = await presentProfiles((name) => root.exists(name))
  const parts = await Promise.all(present.map(async (profile): Promise<Partial<RepoConfig>> => (await profile.defaults?.(root)) ?? {}))
  const stacks = parts.flatMap((part) => (part.stack ? [part.stack] : []))
  const setups = parts.flatMap((part) => (part.setup ? [part.setup] : []))
  const tests = parts.find((part) => part.tests)?.tests
  return {
    ...(stacks.length > 0 ? { stack: stacks.join(', ') } : {}),
    checks: Object.assign({}, ...parts.map((part) => part.checks ?? {})),
    ...(tests ? { tests } : {}),
    ...(setups.length > 0 ? { setup: setups.join(' && ') } : {}),
    protect: [...new Set([...protectedEverywhere, ...parts.flatMap((part) => part.protect ?? [])])],
  }
}

export const profilesById = (ids: string[]) => profiles.filter((profile) => ids.includes(profile.id))

/** The profiles whose marker files all exist in the repository. */
export async function presentProfiles(exists: (path: string) => Promise<boolean>): Promise<Profile[]> {
  const present: Profile[] = []
  for (const profile of profiles) if ((await Promise.all(profile.markers.map(exists))).every(Boolean)) present.push(profile)
  return present
}

/** The changed paths that no change may commit: build output, scratch logs, environment files. */
export function forbiddenPaths(changed: string[], active: Profile[]): string[] {
  const forbidden = [...forbiddenEverywhere, ...active.flatMap((profile) => profile.forbidden)]
  return changed.filter((path) => forbidden.some((pattern) => pattern.test(path)))
}

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

/** `changed` holds every path that the change touches, also deleted paths and the old path of a rename. */
export async function triage(changed: string[], exists: (path: string) => Promise<boolean>, full: boolean): Promise<Triage> {
  const present = await presentProfiles(exists)
  const governing = present.filter((profile) => changed.some((path) => profile.files.test(path)))
  const guides = governing.flatMap((profile) => profile.guides)
  const resolved = { profiles: present.map((profile) => profile.id), guides: [...new Set(guides)] }
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

/** The path of a `+++` line. Host git uses core.quotePath=false and adds a tab after a path with a space. */
function diffPath(raw: string): string {
  return raw.replace(/\t$/, '').replace(/^b\//, '')
}

/**
 * Checks each line that the diff adds against the rules of the profiles that govern its file, and each changed path
 * against the forbidden paths. The host quotes the line, so these findings skip the evidence check.
 */
export function staticFindings(diff: string, changed: string[], active: Profile[]): Omit<Finding, 'id' | 'track'>[] {
  const findings: Omit<Finding, 'id' | 'track'>[] = []
  for (const path of forbiddenPaths(changed, active))
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
  let blockComment = false
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
      blockComment = false
      continue
    }
    if (header) {
      if (text.startsWith('+++ ')) {
        path = diffPath(text.slice(4))
        rules = active.filter((profile) => profile.files.test(path)).flatMap((profile) => profile.rules)
      }
      continue
    }
    if (text.startsWith('+') || text.startsWith(' ')) {
      const content = text.slice(1)
      const parsed = code(content, blockComment)
      blockComment = parsed.blockComment
      for (const rule of text.startsWith('+') ? rules : [])
        if (rule.breaks(content, previous, parsed.source))
          findings.push({
            location: `${path}:${line}`,
            title: rule.title,
            trigger: `the change adds this line (host rule ${rule.id})`,
            impact: rule.impact,
            severity: rule.severity,
            evidence: content.trim(),
            recommendation: rule.recommendation,
          })
      previous = content
      line++
    }
  }
  return findings
}
