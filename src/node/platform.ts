import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { commandChecker, parseRepoConfig, readRepoConfig, repoConfigFile, requireChecks, resolveRepoConfig, type RepoConfig } from '../core/checks.ts'
import { runLock } from '../core/egress.ts'
import type { AgentStore, Files, Guides, PullRequests, Signing } from '../core/platform.ts'
import { profileDefaults, type RootFiles } from '../core/profiles.ts'
import type { Credentials } from '../core/providers.ts'
import type { SigningRecord } from '../core/signing.ts'
import type { Channel } from '../core/questions.ts'
import { loadResearchDomain, type ResearchConfig, type ResearchDomain, type ResearchFiles } from '../core/research.ts'
import { StopError } from '../core/stop.ts'
import type { Prices } from '../core/usage.ts'
import { codeReviewLoop, type LoopDeps } from '../core/workflows/code-review-loop.ts'
import type { DevelopDeps, DevelopInput } from '../core/workflows/develop.ts'
import type { ResearchDeps, ResearchInput } from '../core/workflows/research.ts'
import { nodeArtifacts } from './artifacts.ts'
import { diskFileSystem, guideFileSystem } from './disk.ts'
import { gitBranches, gitRepo, gitTree, worktreePath, type GitCommits, type GitSource } from './git.ts'
import { fileLedger } from './ledger.ts'
import { localMachine } from './machine.ts'
import { nodeSigning } from './signing.ts'

export const agentsDir = fileURLToPath(new URL('../../agents/', import.meta.url))

/** The files at the root of a working copy. */
function diskRoot(repo: string): RootFiles {
  const file = (name: string) => join(repo, name)
  return {
    exists: async (name) => existsSync(file(name)),
    read: async (name) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null),
    // A symlink counts by its target, as exists() and read() follow it.
    list: async () =>
      readdirSync(repo).filter((name) => {
        try {
          return statSync(file(name)).isFile()
        } catch {
          return false
        }
      }),
  }
}

/**
 * The config of a repository on this machine, from its working copy: the profile defaults, and its
 * .agent-factory.json or the file at `path`. A local run runs the checks, so it needs at least one.
 */
export async function loadRepoConfig(repo: string, path?: string): Promise<RepoConfig> {
  const root = diskRoot(repo)
  if (path && !existsSync(path)) throw new StopError(`${path} does not exist`)
  const config = path ? resolveRepoConfig(await profileDefaults(root), parseRepoConfig(readFileSync(path, 'utf8'), path)) : await readRepoConfig(root, `in ${repo}`)
  requireChecks(config, repo)
  return withHomeGuides(config)
}

/** A guide path that starts with ~/ is in the home directory. */
function withHomeGuides(config: RepoConfig): RepoConfig {
  const guides = Object.entries(config.guides ?? {}).map(([name, guide]) => [name, guide.replace(/^~(?=\/)/, homedir())])
  return { ...config, guides: Object.fromEntries(guides) }
}

/**
 * The status of a path relative to `repo`, or null when the path is missing or a part of it is a symlink. The
 * contents API on Cloudflare does not give symlinks as files or directories, and a symlink can point out of the
 * repository, so the two readers both ignore symlinks.
 */
function plainStat(repo: string, path: string) {
  try {
    let current = repo
    let info = statSync(repo, { throwIfNoEntry: false }) ?? null
    for (const part of path.split('/').filter((part) => part !== '' && part !== '.')) {
      if (!info?.isDirectory()) return null
      current = join(current, part)
      info = lstatSync(current, { throwIfNoEntry: false }) ?? null
      if (!info || info.isSymbolicLink()) return null
    }
    return info
  } catch {
    return null
  }
}

/** The files of a working copy at paths relative to its root, without symlinks, as the reader on Cloudflare. */
function diskFiles(repo: string): ResearchFiles {
  return {
    read: async (path) => (plainStat(repo, path)?.isFile() ? readFileSync(join(repo, path), 'utf8') : null),
    async list(dir) {
      if (!plainStat(repo, dir)?.isDirectory()) return null
      return readdirSync(join(repo, dir)).filter((name) => plainStat(repo, `${dir}/${name}`)?.isFile() ?? false)
    },
  }
}

/**
 * The research domain from the working copy. The paths of the research config are relative to the repository root,
 * also when the config comes from a file in another directory.
 */
export async function loadResearch(repo: string, research: ResearchConfig): Promise<ResearchDomain> {
  return loadResearchDomain(research, diskFiles(repo), `in ${repo}`)
}

/** Host guides from agents/, plus the repository's guides from its config. */
export async function nodeGuides(config: RepoConfig): Promise<Guides> {
  const mounts: Record<string, FileSystem.FileSystem> = {}
  const hostGuides = join(agentsDir, 'guides')
  for (const name of readdirSync(hostGuides)) mounts[name] = diskFileSystem(join(hostGuides, name))
  for (const [name, path] of Object.entries(config.guides ?? {})) {
    if (!existsSync(path)) throw new StopError(`guide ${name} does not exist at ${path}`)
    mounts[name] = await guideFileSystem(path)
  }
  return { mounts, read: (file) => readFileSync(join(agentsDir, file), 'utf8') }
}

/** Every agent of a run journals to one SQLite file, each in its own scope, and logs its events to agents/<id>.events.jsonl. */
export function sqliteStore(path: string, eventsDir: string): AgentStore {
  const db = new DatabaseSync(path)
  mkdirSync(eventsDir, { recursive: true })
  return {
    sql: {
      transaction(_kind, _operation, statements) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const rows = statements.map(([query, ...values]) => {
            const statement = db.prepare(query)
            statement.setReturnArrays(true)
            return statement.all(...(values as SQLInputValue[])) as unknown as Contracts.SqlValue[][]
          })
          db.exec('COMMIT')
          return rows
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
    },
    scope: (agentId) => agentId,
    record(agentId, events) {
      appendFileSync(join(eventsDir, `${agentId}.events.jsonl`), events.map((event) => `${JSON.stringify(event)}\n`).join(''))
    },
  }
}

export function dirFiles(dir: string): Files {
  return {
    write: (name, text) => writeFileSync(join(dir, name), text),
    append: (name, text) => appendFileSync(join(dir, name), text),
    exists: (name) => existsSync(join(dir, name)),
  }
}

export type NodeRun = Pick<LoopDeps, 'ledger' | 'repo' | 'checker' | 'signing' | 'files' | 'store' | 'guides'> & { dir: string }

/** The platform of one run on this machine: runs/<id>/ holds the ledger, the worktree, the journals and the report. */
export async function nodeRun(options: { runsDir: string; runId: string; source: GitSource; config: RepoConfig }): Promise<NodeRun> {
  const dir = resolve(options.runsDir, options.runId)
  mkdirSync(dir, { recursive: true })
  const tree = join(dir, 'tree')
  // The signing step sets the commit mode, and the repository reads it at each commit.
  const commits: GitCommits = { unsigned: false }
  const repo = gitRepo(options.source, tree, `factory/${options.runId}`, commits)
  return {
    dir,
    ledger: fileLedger(join(dir, 'state.json')),
    repo,
    checker: commandChecker(repo, options.config, localMachine(tree)),
    signing: nodeSigning(options.source.repo, commits),
    files: dirFiles(dir),
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    guides: await nodeGuides(options.config),
  }
}

export type NodeDevelopOptions = {
  runsDir: string
  /** The repository on this machine. Its origin is on GitHub. */
  repo: string
  input: DevelopInput
  /** Where the intake and spec questions go, and where the review questions go once the PR exists. */
  channel: Channel
  reviewChannel(pr: number): Promise<Channel>
  pulls: PullRequests
  credentials: Credentials
  module: WebAssembly.Module
  dispatch?: Contracts.RuntimeOptions['dispatch']
  /** USD per million tokens of each model, for the development run and its review loop passes. */
  prices?: Prices
  ci: DevelopDeps['ci']
  log(line: string): void
}

/**
 * The platform of one development run on this machine: runs/<id>/ holds the ledger, the journals, the report and
 * a worktree for each branch. Each review loop pass is a run of its own, runs/<id>-review-<pass>/.
 */
export async function nodeDevelop(options: NodeDevelopOptions): Promise<DevelopDeps & { dir: string }> {
  const { input } = options
  const dir = resolve(options.runsDir, input.runId)
  const branchesDir = join(dir, 'branches')
  mkdirSync(branchesDir, { recursive: true })
  const commits: GitCommits = { unsigned: false }
  const signing = nodeSigning(options.repo, commits)
  // The answer for the development branch. Each review pass of that branch uses it and does not call GitHub again.
  let recorded: SigningRecord | undefined
  const host = { credentials: options.credentials, dispatch: options.dispatch, log: options.log, module: options.module, prices: options.prices }
  return {
    ...host,
    dir,
    ledger: fileLedger(join(dir, 'state.json')),
    files: dirFiles(dir),
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    guides: await nodeGuides(input.config),
    channel: options.channel,
    branches: gitBranches(options.repo, branchesDir, commits),
    signing: {
      check: signing.check,
      async apply(record) {
        recorded = record
        await signing.apply(record)
      },
    },
    pulls: options.pulls,
    checker: (branch) => commandChecker(branch, input.config, localMachine(worktreePath(branchesDir, branch.name))),
    async review({ runId, ask, head, branch, full, pr, budget }) {
      const source = { repo: options.repo, base: input.base, head }
      const run = await nodeRun({ config: input.config, runId, runsDir: options.runsDir, source })
      run.ledger.put('git', source)
      const loopInput = { allowedModels: input.allowedModels, ask, config: input.config, headRef: branch, models: input.models.review, pr, runId, source: `${options.repo} ${input.baseRef}..${head.slice(0, 12)}`, ...(full ? { full } : {}), ...(budget !== undefined ? { budgetOverride: budget } : {}), stopAtBudget: true }
      // The pass runs again after a raise with a new remaining budget, so the budget is an override, not the recorded value.
      // At the budget, the pass stops without a question, and the development run asks with the run totals.
      const passSigning: Signing = { apply: run.signing.apply, check: async (branches) => recorded ?? run.signing.check(branches) }
      return codeReviewLoop(loopInput, { ...run, ...host, channel: await options.reviewChannel(pr), signing: passSigning })
    },
    ci: options.ci,
  }
}

export type NodeResearchOptions = {
  runsDir: string
  /** The notebook working copy. The run reads its base commit and commits the frozen preregs on a branch of its own. */
  repo: string
  input: ResearchInput
  channel: Channel
  credentials: Credentials
  module: WebAssembly.Module
  dispatch?: Contracts.RuntimeOptions['dispatch']
  prices?: Prices
  /** Where the egress finds the secrets of the research config. Default: process.env. */
  env?: Record<string, string | undefined>
  /** Replaces the global fetch of the egress, for tests. */
  fetch?: typeof fetch
  log(line: string): void
}

/**
 * The platform of one research run on this machine: runs/<id>/ holds the ledger, the journals, the artifacts, the
 * report and the branch worktrees. The config, the holdout, the checklist and the guides come from the base commit,
 * never from the working copy, so an uncommitted change cannot move the holdout.
 */
export async function nodeResearch(options: NodeResearchOptions): Promise<ResearchDeps & { dir: string }> {
  const { input } = options
  const dir = resolve(options.runsDir, input.runId)
  const branchesDir = join(dir, 'branches')
  mkdirSync(branchesDir, { recursive: true })
  const source = `at ${input.baseRef}`
  const base = gitTree(options.repo, input.base)
  const config = await readRepoConfig(base.root, source)
  if (!config.research) throw new StopError(`${repoConfigFile} ${source} has no research field`)
  const domain = await loadResearchDomain(config.research, base.files, source)
  const ledger = fileLedger(join(dir, 'state.json'))
  const env = options.env ?? process.env
  return {
    dir,
    module: options.module,
    ledger,
    files: dirFiles(dir),
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    guides: await nodeGuides(withHomeGuides(config)),
    credentials: options.credentials,
    dispatch: options.dispatch,
    prices: options.prices,
    channel: options.channel,
    branches: gitBranches(options.repo, branchesDir),
    domain,
    egress: {
      artifacts: nodeArtifacts(dir),
      lock: runLock(ledger, domain.holdout.refuse),
      secret: (name) => env[name],
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
    log: options.log,
  }
}
