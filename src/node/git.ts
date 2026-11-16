import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Branch, Branches, Frozen, Repo } from '../core/platform.ts'
import type { RootFiles } from '../core/profiles.ts'
import type { ResearchFiles } from '../core/research.ts'
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

/** A local git repository: the review runs in a worktree of its own, on branch `branch`. */
export function gitRepo(source: GitSource, tree: string, branch: string): Repo {
  return {
    tree: diskFileSystem(tree),
    freeze: () => freeze(source.repo, source.base, source.head, tree, branch),
    diff: (from, to) => diff(tree, from, to),
    changedFiles: (from, to) => changedFiles(tree, from, to),
    touchedFiles: (from, to) => touchedFiles(tree, from, to),
    committedFiles: () => trackedFiles(tree),
    commit: (message) => commitAll(tree, message),
    head: () => currentCommit(tree),
    async ship({ pr, headRef }) {
      await git(tree, 'push', 'origin', `HEAD:refs/heads/${headRef}`)
      const run = gh(tree)
      if ((JSON.parse(await run(['pr', 'view', String(pr), '--json', 'isDraft'])) as { isDraft: boolean }).isDraft) await run(['pr', 'ready', String(pr)])
    },
  }
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
  }
}

type TreeEntry = { mode: string; type: string; object: string; name: string }

/** The entries that `git ls-tree` gives for a path, or for the root without a path. Names are relative to the root. */
async function treeEntries(repo: string, commit: string, spec?: string): Promise<TreeEntry[]> {
  const out = await git(repo, 'ls-tree', '-z', '--full-tree', commit, ...(spec === undefined ? [] : ['--', spec]))
  return out.split('\0').flatMap((line) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line)
    return match ? [{ mode: match[1]!, type: match[2]!, object: match[3]!, name: match[4]! }] : []
  })
}

/** A regular file. Symlinks (mode 120000) are not files, as for the readers of a working copy and of Cloudflare. */
const isFile = (entry: TreeEntry) => entry.type === 'blob' && entry.mode !== '120000'

/**
 * The files of a commit, read with git and never from the working copy: `files` by path relative to the root, and
 * `root` for the config and the profile markers.
 */
export function gitTree(repo: string, commit: string): { files: ResearchFiles; root: RootFiles } {
  const clean = (path: string) => path.split('/').filter((part) => part !== '' && part !== '.').join('/')
  const read = async (path: string) => {
    const name = clean(path)
    const entry = name === '' ? undefined : (await treeEntries(repo, commit, name)).find((item) => item.name === name)
    return entry && isFile(entry) ? git(repo, 'cat-file', 'blob', entry.object) : null
  }
  const list = async (dir: string) => {
    const name = clean(dir)
    const entries = name === '' ? await treeEntries(repo, commit) : await treeEntries(repo, commit, `${name}/`)
    // git does not keep empty directories, so a directory without entries does not exist.
    if (entries.length === 0) return null
    return entries.filter(isFile).map((entry) => entry.name.slice(name === '' ? 0 : name.length + 1))
  }
  return {
    files: { read, list },
    root: {
      exists: async (name) => (await treeEntries(repo, commit, clean(name))).some((entry) => entry.name === clean(name)),
      read,
      list: async () => (await list('')) ?? [],
    },
  }
}
