import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Branch, Branches, Frozen, Repo } from '../core/platform.ts'
import { withoutHostSecrets } from '../core/secrets.ts'
import { gh } from './channels.ts'
import { diskFileSystem } from './disk.ts'

const exec = promisify(execFile)
const maxOutputBytes = 512 * 1024 * 1024

/** The host's git never runs repository hooks or an fsmonitor, so files in the tree cannot run code through it. */
const hardened = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false']

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', [...hardened, ...args], { cwd, env: withoutHostSecrets(process.env), maxBuffer: maxOutputBytes })
  return stdout
}

/** Freezes the review target: a worktree of `head` on its own branch, and the merge base with `base`. */
export async function freeze(repo: string, base: string, head: string, tree: string, branch: string): Promise<Frozen> {
  const headSha = (await git(repo, 'rev-parse', '--verify', `${head}^{commit}`)).trim()
  const baseSha = (await git(repo, 'merge-base', base, headSha)).trim()
  if (!existsSync(tree)) await git(repo, 'worktree', 'add', '-b', branch, tree, headSha)
  return { base: baseSha, head: headSha, branch, location: `worktree ${tree}` }
}

export function diff(tree: string, from: string, to: string): Promise<string> {
  return git(tree, 'diff', '--no-color', '--no-ext-diff', `${from}..${to}`)
}

/** Files that exist after the change: added, copied, modified, renamed. */
export async function changedFiles(tree: string, from: string, to: string): Promise<string[]> {
  const names = await git(tree, 'diff', '--name-only', '--diff-filter=ACMR', `${from}..${to}`)
  return names.split('\n').filter(Boolean)
}

/** Every path that the change touches: the changed files, the deleted files, and the old path of each rename. */
export async function touchedFiles(tree: string, from: string, to: string): Promise<string[]> {
  const names = await git(tree, 'diff', '--name-only', '--no-renames', `${from}..${to}`)
  return names.split('\n').filter(Boolean)
}

/** Files that the host committed. Files that an agent created are not in this list until the host commits them. */
export async function trackedFiles(tree: string): Promise<string[]> {
  const names = await git(tree, 'ls-files', '--cached')
  return names.split('\n').filter(Boolean)
}

/** Commits every change in the worktree. Does nothing when nothing changed. */
export async function commitAll(tree: string, message: string): Promise<void> {
  await git(tree, 'add', '-A')
  const staged = await git(tree, 'diff', '--cached', '--name-only')
  if (staged.trim() !== '') await git(tree, 'commit', '--no-verify', '-m', message)
}

export async function currentCommit(tree: string): Promise<string> {
  return (await git(tree, 'rev-parse', 'HEAD')).trim()
}

export type GitSource = { repo: string; base: string; head: string }

/**
 * A local git repository: the review runs in a worktree of its own, on branch `branch`. A resumed run after a release
 * has no worktree. Each git method recreates it from the branch, and the loop calls one before an agent reads the tree.
 */
export function gitRepo(source: GitSource, tree: string, branch: string): Repo {
  const ensure = async () => {
    if (existsSync(tree) || !(await branchExists(source.repo, branch))) return
    await git(source.repo, 'worktree', 'prune')
    await git(source.repo, 'worktree', 'add', tree, branch)
  }
  const inTree =
    <A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
    async (...args: A) => {
      await ensure()
      return run(...args)
    }
  return {
    tree: diskFileSystem(tree),
    freeze: () => freeze(source.repo, source.base, source.head, tree, branch),
    diff: inTree((from: string, to: string) => diff(tree, from, to)),
    changedFiles: inTree((from: string, to: string) => changedFiles(tree, from, to)),
    touchedFiles: inTree((from: string, to: string) => touchedFiles(tree, from, to)),
    committedFiles: inTree(() => trackedFiles(tree)),
    commit: inTree((message: string) => commitAll(tree, message)),
    head: inTree(() => currentCommit(tree)),
    ship: inTree(async ({ pr, headRef }: { pr: number; headRef: string }) => {
      await git(tree, 'push', 'origin', `HEAD:refs/heads/${headRef}`)
      const run = gh(tree)
      if ((JSON.parse(await run(['pr', 'view', String(pr), '--json', 'isDraft'])) as { isDraft: boolean }).isDraft) await run(['pr', 'ready', String(pr)])
    }),
    async pullState(pr) {
      const { state } = JSON.parse(await gh(source.repo)(['pr', 'view', String(pr), '--json', 'state'])) as { state: string }
      return state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open'
    },
    async deleteBranch() {
      // A local --base run can have no origin.
      const remotes = (await git(source.repo, 'remote')).split('\n')
      if (remotes.includes('origin') && (await remoteBranchExists(source.repo, branch))) await git(source.repo, 'push', 'origin', '--delete', `refs/heads/${branch}`)
      await deleteLocalBranch(source.repo, branch)
    },
    release: () => removeWorktrees(source.repo, (path) => isUnder(path, tree)),
  }
}

/** The worktrees of the repository, with the branch of each, or null for a detached worktree. */
async function worktrees(repo: string): Promise<{ path: string; branch: string | null }[]> {
  // A worktree whose directory is gone stays registered until a prune, and blocks a new worktree of its branch.
  await git(repo, 'worktree', 'prune')
  return (await git(repo, 'worktree', 'list', '--porcelain'))
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? ''
      const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
      return { path, branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null }
    })
}

/** True when `path` is `dir` or inside it. git gives real paths, so a symlinked temp directory compares by its real path too. */
function isUnder(path: string, dir: string): boolean {
  const roots = [resolve(dir), ...(existsSync(dir) ? [realpathSync(dir)] : [])]
  return roots.some((root) => path === root || path.startsWith(root + sep))
}

/** Removes the worktrees that `match` selects, never the main worktree. Their branches stay. */
async function removeWorktrees(repo: string, match: (path: string, branch: string | null) => boolean): Promise<void> {
  const [, ...linked] = await worktrees(repo)
  for (const entry of linked) if (match(entry.path, entry.branch)) await git(repo, 'worktree', 'remove', '--force', entry.path)
}

/** Removes the worktree of the branch, wherever it is, then deletes the branch. An absent branch counts as deleted. */
async function deleteLocalBranch(repo: string, name: string): Promise<void> {
  await removeWorktrees(repo, (_path, branch) => branch === name)
  // -D: a squash merge or a merge on GitHub leaves the branch unmerged in the local history.
  if (await branchExists(repo, name)) await git(repo, 'branch', '-D', name)
}

/** Where the worktree of a branch lives, under the run's directory. */
export const worktreePath = (dir: string, name: string) => join(dir, name.replace(/\//g, '-'))

async function branchExists(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`)
    return true
  } catch {
    return false
  }
}

/** True when origin has the branch. `git ls-remote --exit-code` exits with 2 when no ref matches. */
async function remoteBranchExists(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${name}`)
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 2) return false
    throw error
  }
}

function gitBranch(tree: string, name: string): Branch {
  return {
    name,
    tree: diskFileSystem(tree),
    head: () => currentCommit(tree),
    changedFiles: (from, to) => changedFiles(tree, from, to),
    committedFiles: () => trackedFiles(tree),
    async pending() {
      // Staging shows new files in the diff. The reset after it keeps the index as it was, so run_tests still sees only committed files.
      await git(tree, 'add', '-A')
      try {
        const patch = await git(tree, 'diff', '--cached', '--no-color', '--no-ext-diff')
        const names = await git(tree, 'diff', '--cached', '--name-only', '--diff-filter=ACMRT')
        const removed = await git(tree, 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D')
        return { diff: patch, changed: names.split('\n').filter(Boolean), removed: removed.split('\n').filter(Boolean) }
      } finally {
        await git(tree, 'reset', '-q')
      }
    },
    commit: (message) => commitAll(tree, message),
    /** A fast-forward when it can, else a merge commit. A failed merge is aborted, so that a resume starts from a clean worktree. */
    async merge(ref, message) {
      try {
        await git(tree, 'merge', '--ff', '--no-edit', '-m', message, ref)
      } catch (error) {
        await git(tree, 'merge', '--abort').catch(() => undefined)
        throw error
      }
    },
  }
}

/** The branches of a development run, each in a worktree under `dir`. */
export function gitBranches(repo: string, dir: string): Branches {
  return {
    async view(commit) {
      const tree = join(dir, `view-${commit.slice(0, 12)}`)
      if (!existsSync(tree)) await git(repo, 'worktree', 'add', '--detach', tree, commit)
      return diskFileSystem(tree)
    },
    async branch(name, from) {
      const tree = worktreePath(dir, name)
      if (!existsSync(tree)) {
        if (await branchExists(repo, name)) await git(repo, 'worktree', 'add', tree, name)
        else await git(repo, 'worktree', 'add', '-b', name, tree, from)
      }
      return gitBranch(tree, name)
    },
    exists: async (name) => (await branchExists(repo, name)) || (await remoteBranchExists(repo, name)),
    async push(branch) {
      await git(worktreePath(dir, branch.name), 'push', 'origin', `HEAD:refs/heads/${branch.name}`)
      return branch.head()
    },
    async deleteRemote(name) {
      if (await remoteBranchExists(repo, name)) await git(repo, 'push', 'origin', '--delete', `refs/heads/${name}`)
    },
    deleteLocal: (name) => deleteLocalBranch(repo, name),
    release: () => removeWorktrees(repo, (path) => isUnder(path, dir)),
  }
}
