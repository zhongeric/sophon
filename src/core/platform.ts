import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import type { CiJob } from './ci.ts'
import type { CheckResult, MergeMethod } from './checks.ts'
import type { SigningRecord } from './signing.ts'
import type { PullState } from './prune.ts'

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
  pullState(pr: number): Promise<PullState>
  /** Deletes the fix branch of the run on origin and locally, with its worktree. A branch that is absent counts as deleted. */
  deleteBranch(): Promise<void>
  /** Removes the worktree of the run. The branch stays. */
  release(): Promise<void>
}

/** A branch in a worktree of its own, where one builder writes. The host commits. */
export type Branch = {
  readonly name: string
  readonly tree: FileSystem.FileSystem
  head(): Promise<string>
  changedFiles(from: string, to: string): Promise<string[]>
  /** Every path that the change touches, including deleted files and the old path of each rename. */
  touchedFiles(from: string, to: string): Promise<string[]>
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
  /**
   * Deletes the branch on origin only. The local branch and its worktree stay. A branch that is already absent on
   * origin counts as deleted, for example when the repository deletes head branches after a merge.
   */
  deleteRemote(name: string): Promise<void>
  /** Removes the worktree that has the branch, wherever it is, then deletes the local branch. A branch that is absent counts as deleted. */
  deleteLocal(name: string): Promise<void>
  /** Removes every worktree of the run. The branches stay. */
  release(): Promise<void>
}

/** The result of a merge. GitHub can refuse a merge, for example for a conflict, a changed head or a check that is not green. */
export type MergeResult = { merged: true; sha: string } | { merged: false; reason: string }

/** The pull requests and the CI of the repository on GitHub. */
export type PullRequests = {
  /** Opens a draft PR from `head` to the base branch, or returns the open PR of `head`. */
  open(options: { head: string; title: string; body: string }): Promise<{ number: number; url: string }>
  /** Marks a draft PR ready for review. */
  ready(pr: number): Promise<void>
  /** Merges the PR only when its head is still `sha`. A refusal by GitHub is a result, not an error. */
  merge(pr: number, options: { method: MergeMethod; sha: string }): Promise<MergeResult>
  comment(pr: number, body: string): Promise<void>
  ci(sha: string): Promise<CiJob[]>
  /** The end of the log of a failed job, for the agent that fixes it. */
  failureLog(job: CiJob): Promise<string>
}

/** Whether the commits of a run are signed. Each platform has its own. */
export type Signing = {
  /** Reads the signature rules of the branches that the run pushes and gives the commit mode. No GitHub call without a GitHub origin or without branches. */
  check(branches: string[]): Promise<SigningRecord>
  /** Prepares the commits of this process for the recorded answer, before the first commit. Throws StopError when the host cannot commit as the answer requires. */
  apply(record: SigningRecord): Promise<void>
}

/** Runs the repository's checks. `tests` runs test files during agent turns, or is null where the platform cannot. */
export type Checker = {
  /**
   * Runs the configured checks on the changed files, then their targeted tests. The tests run by default. With
   * `tests: false`, only the setup and the configured checks run.
   */
  checks(changed: string[], options?: { tests?: boolean }): Promise<CheckResult[]>
  tests: ((tests: string[]) => Promise<CheckResult[]>) | null
  /**
   * The configured checks without tests, on a real machine, for the run_checks tool of an agent. Absent where the
   * platform has no machine for agents. An agent tool never calls `checks`, because on Cloudflare it is the CI.
   */
  agentChecks?: (changed: string[]) => Promise<CheckResult[]>
}

/** The output files of the run, such as report.md and gate-log.txt. */
export type Files = {
  write(name: string, text: string): void
  append(name: string, text: string): void
  exists(name: string): boolean
}

/** Where an artifact came from, so that a later step can fetch it or run it again. */
export type ArtifactSource = { url: string; method: string } | { command: string }

/** The meta that the caller gives to `Artifacts.put`. The store sets the size and the time. */
export type ArtifactInput = { source: ArtifactSource; media_type: string; labels?: Record<string, string> }

/** The stored meta of an artifact. `created` is the time of the first put, in milliseconds since the epoch. */
export type ArtifactMeta = { source: ArtifactSource; media_type: string; labels: Record<string, string>; size: number; created: number }

/**
 * The content-addressed store of one run. The ledger keeps artifact IDs, never bulk data. The ID is the SHA-256
 * lowercase hex of the bytes, so the same bytes give the same ID, and the first meta stays.
 */
export type Artifacts = {
  put(bytes: Uint8Array, meta: ArtifactInput): Promise<string>
  /** Null for an unknown or malformed ID. */
  get(id: string): Promise<Uint8Array | null>
  /** Null for an unknown or malformed ID. */
  meta(id: string): Promise<ArtifactMeta | null>
  /** Every artifact, in the order of `created`, then of ID. */
  list(): Promise<{ id: string; meta: ArtifactMeta }[]>
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
