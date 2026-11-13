import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import type { CiJob } from './ci.ts'
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
  /** Every path that the change touches: the changed files, the deleted files, and the old path of each rename. */
  touchedFiles(from: string, to: string): Promise<string[]>
  /** Files of the last host commit. Files that an agent created are not in it until the host commits them. */
  committedFiles(): Promise<string[]>
  /** Commits every change in the tree. Does nothing when nothing changed. */
  commit(message: string): Promise<void>
  head(): Promise<string>
  /** Puts the fixes on the PR branch, without force, and marks the PR ready. */
  ship(target: { pr: number; headRef: string }): Promise<void>
}

/** A branch in a worktree of its own, where one builder writes. The host commits. */
export type Branch = {
  readonly name: string
  readonly tree: FileSystem.FileSystem
  head(): Promise<string>
  changedFiles(from: string, to: string): Promise<string[]>
  committedFiles(): Promise<string[]>
  /** The uncommitted changes against the last commit, new files included: their diff, the paths that exist after them, and the deleted paths. */
  pending(): Promise<{ diff: string; changed: string[]; removed: string[] }>
  /** Commits every uncommitted change. Does nothing when nothing changed. */
  commit(message: string): Promise<void>
  /** Brings the changes of a branch or commit into this branch, in one or more commits. */
  merge(ref: string, message: string): Promise<void>
}

/** The local branches of the repository that the development workflow changes. */
export type Branches = {
  /** The tree of a commit, for the agents that read before anyone writes. */
  view(commit: string): Promise<FileSystem.FileSystem>
  /** Creates a branch from a commit in a worktree of its own, or reopens it. */
  branch(name: string, from: string): Promise<Branch>
  exists(name: string): Promise<boolean>
  /** Pushes the branch to origin, never with force, and returns the commit ID that GitHub has for its head. */
  push(branch: Branch): Promise<string>
}

/** The pull requests and the CI of the repository on GitHub. */
export type PullRequests = {
  /** Opens a draft PR from `head` to the base branch, or returns the open PR of `head`. */
  open(options: { head: string; title: string; body: string }): Promise<{ number: number; url: string }>
  /** Marks a draft PR ready for review. */
  ready(pr: number): Promise<void>
  comment(pr: number, body: string): Promise<void>
  ci(sha: string): Promise<CiJob[]>
  /** The end of the log of a failed job, for the agent that fixes it. */
  failureLog(job: CiJob): Promise<string>
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
