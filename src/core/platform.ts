import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import type { CheckResult } from './checks.ts'

/** The frozen review target. `base` and `head` are commit IDs that `Repo.diff` accepts. */
export type Frozen = { base: string; head: string; branch: string; location: string }

/** The repository of one run: its working tree and its commits. Each platform has its own. */
export type Repo = {
  /** The working tree, as the file system that agents read and patch agents write. */
  readonly tree: FileSystem.FileSystem
  freeze(): Promise<Frozen>
  diff(from: string, to: string): Promise<string>
  /** Files that exist after the change: added, copied, modified, renamed. */
  changedFiles(from: string, to: string): Promise<string[]>
  /** Files of the last host commit. Files that an agent created are not in it until the host commits them. */
  committedFiles(): Promise<string[]>
  /** Commits every change in the tree. Does nothing when nothing changed. */
  commit(message: string): Promise<void>
  head(): Promise<string>
  /** Puts the fixes on the PR branch, without force, and marks the PR ready. */
  ship(target: { pr: number; headRef: string }): Promise<void>
}

/** Runs the repository's checks. `tests` runs test files during agent turns, or is null where the platform cannot. */
export type Checker = {
  checks(changed: string[]): Promise<CheckResult[]>
  tests: ((tests: string[]) => Promise<CheckResult[]>) | null
}

/** The run's artifacts, such as report.md and gate-log.txt. */
export type Files = {
  write(name: string, text: string): void
  append(name: string, text: string): void
  exists(name: string): boolean
}

/** Where agent sessions keep their journals and events. */
export type AgentStore = {
  sql: Contracts.SqlHost
  /** The session log scope of one agent. */
  scope(agentId: string): string
  record(agentId: string, events: Contracts.LoggedEvent[]): void
}

/** Guideline files by name, and reference material mounted at /guides/<name>. */
export type Guides = {
  read(file: string): string
  mounts: Record<string, FileSystem.FileSystem>
}
