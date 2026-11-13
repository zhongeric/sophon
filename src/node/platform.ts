import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { commandChecker, parseRepoConfig, type RepoConfig } from '../core/checks.ts'
import type { AgentStore, Files, Guides, PullRequests } from '../core/platform.ts'
import type { Credentials } from '../core/providers.ts'
import type { Channel } from '../core/questions.ts'
import { StopError } from '../core/stop.ts'
import { codeReviewLoop, type LoopDeps } from '../core/workflows/code-review-loop.ts'
import type { DevelopDeps, DevelopInput } from '../core/workflows/develop.ts'
import { diskFileSystem, guideFileSystem } from './disk.ts'
import { gitBranches, gitRepo, worktreePath, type GitSource } from './git.ts'
import { fileLedger } from './ledger.ts'
import { localMachine } from './machine.ts'

export const agentsDir = fileURLToPath(new URL('../../agents/', import.meta.url))

export function loadRepoConfig(path: string): RepoConfig {
  if (!existsSync(path)) throw new StopError(`${path} does not exist. Add it with the checks of the repository (see README).`)
  const config = parseRepoConfig(readFileSync(path, 'utf8'), path)
  const guides = Object.entries(config.guides ?? {}).map(([name, guide]) => [name, guide.replace(/^~(?=\/)/, homedir())])
  return { ...config, guides: Object.fromEntries(guides) }
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

export type NodeRun = Pick<LoopDeps, 'ledger' | 'repo' | 'checker' | 'files' | 'store' | 'guides'> & { dir: string }

/** The platform of one run on this machine: runs/<id>/ holds the ledger, the worktree, the journals and the report. */
export async function nodeRun(options: { runsDir: string; runId: string; source: GitSource; config: RepoConfig }): Promise<NodeRun> {
  const dir = resolve(options.runsDir, options.runId)
  mkdirSync(dir, { recursive: true })
  const tree = join(dir, 'tree')
  const repo = gitRepo(options.source, tree, `factory/${options.runId}`)
  return {
    dir,
    ledger: fileLedger(join(dir, 'state.json')),
    repo,
    checker: commandChecker(repo, options.config, localMachine(tree)),
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
  const host = { credentials: options.credentials, dispatch: options.dispatch, log: options.log, module: options.module }
  return {
    ...host,
    dir,
    ledger: fileLedger(join(dir, 'state.json')),
    files: dirFiles(dir),
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    guides: await nodeGuides(input.config),
    channel: options.channel,
    branches: gitBranches(options.repo, branchesDir),
    pulls: options.pulls,
    checker: (branch) => commandChecker(branch, input.config, localMachine(worktreePath(branchesDir, branch.name))),
    async review({ runId, ask, head, full, pr }) {
      const source = { repo: options.repo, base: input.base, head }
      const run = await nodeRun({ config: input.config, runId, runsDir: options.runsDir, source })
      run.ledger.put('git', source)
      const loopInput = { ask, config: input.config, models: input.models.review, pr, runId, source: `${options.repo} ${input.baseRef}..${head.slice(0, 12)}`, ...(full ? { full } : {}) }
      return codeReviewLoop(loopInput, { ...run, ...host, channel: await options.reviewChannel(pr) })
    },
    ci: options.ci,
  }
}
