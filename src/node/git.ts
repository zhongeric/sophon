import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Frozen, Repo } from '../core/platform.ts'
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
