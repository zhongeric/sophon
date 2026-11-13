import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { commandChecker, parseRepoConfig, type RepoConfig } from '../core/checks.ts'
import type { AgentStore, Files, Guides } from '../core/platform.ts'
import { StopError } from '../core/stop.ts'
import type { LoopDeps } from '../core/workflows/code-review-loop.ts'
import { diskFileSystem, guideFileSystem } from './disk.ts'
import { gitRepo, type GitSource } from './git.ts'
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
