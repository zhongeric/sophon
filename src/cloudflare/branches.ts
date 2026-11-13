import type { Contracts } from 'nanocode-ts'
import { SqlFileSystem } from 'nanocode-ts/bash'
import type { Ledger } from '../core/ledger.ts'
import type { Branch, Branches } from '../core/platform.ts'
import { StopError } from '../core/stop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { base64, copyTree, encodePath, nameStatus, restoreFromGitHub, treeGit, treeWriter, writeTarball, type ChangedFile } from './trees.ts'

type Tree = { scope: string; start: string }

/** The most files that the compare of GitHub lists. */
const compareFileLimit = 300

/**
 * The branches of a development run in Durable Object SQL: one tree for each branch, with in-process git. A new
 * branch copies the tree of its start commit, .git included, so that commit IDs agree across branches. Pushes go
 * to GitHub through the Git Data API, so no token ever reaches the build machine. The ledger maps local commits to
 * their GitHub commits.
 */
export function sqlBranches(options: { gh: GitHub; owner: string; repo: string; sql: Contracts.SqlHost; ledger: Ledger; run: string; log(line: string): void }): Branches {
  const { gh, ledger } = options
  const api = `/repos/${options.owner}/${options.repo}`
  const trees = () => ledger.get<Record<string, Tree>>('trees') ?? {}
  const remotes = () => ledger.get<Record<string, string>>('remotes') ?? {}
  const remember = (local: string, remote: string) => ledger.put('remotes', { ...remotes(), [local]: remote })
  /** A GitHub commit ID as the local commit that stands for it, or the ID as it is. */
  const localOf = (ref: string) => Object.entries(remotes()).find(([, remote]) => remote === ref)?.[0] ?? ref

  const opened = new Map<string, { tree: SqlFileSystem.SqlFileSystem; git: ReturnType<typeof treeGit> }>()
  const open = (scope: string) => {
    let entry = opened.get(scope)
    if (!entry) {
      const tree = SqlFileSystem.create(options.sql, { scope })
      entry = { tree, git: treeGit(tree) }
      opened.set(scope, entry)
    }
    return entry
  }
  const headOf = async (scope: string) => (await open(scope).git('rev-parse', 'HEAD')).trim()

  const setRef = async (name: string, sha: string) => {
    try {
      await gh.json('POST', `${api}/git/refs`, { ref: `refs/heads/${name}`, sha })
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error
      await gh.json('PATCH', `${api}/git/refs/heads/${encodePath(name)}`, { force: false, sha })
    }
  }

  /** Creates the GitHub commit of a local commit: one commit for every local commit since the last pushed one. */
  const createCommit = async (name: string, scope: string, local: string): Promise<string> => {
    const { tree, git } = open(scope)
    const hashes = (await git('log', '--format=%H')).split('\n').filter(Boolean)
    const subjects = (await git('log', '--format=%s')).split('\n')
    const parent = hashes.find((hash) => hash !== local && remotes()[hash])
    if (!parent) throw new Error(`${name}: no commit of the branch is on GitHub yet`)
    const messages = subjects.slice(0, hashes.indexOf(parent)).filter(Boolean).reverse()
    const entries: { path: string; mode: string; type: 'blob'; sha: string | null }[] = []
    for (const [status, path] of nameStatus(await git('diff', '--name-status', `${parent}..${local}`))) {
      // In-process git reads through symlinks. Agents cannot write them, so a change never alters one.
      if ((await tree.lstat(`/${path}`))?.kind === 'symlink') continue
      if (status === 'D') {
        entries.push({ path, mode: '100644', type: 'blob', sha: null })
        continue
      }
      const blob = await gh.json<{ sha: string }>('POST', `${api}/git/blobs`, { content: base64(await tree.read(`/${path}`)), encoding: 'base64' })
      const executable = ((await tree.stat(`/${path}`))?.mode ?? 0) & 0o111
      entries.push({ path, mode: executable ? '100755' : '100644', type: 'blob', sha: blob.sha })
    }
    const base = await gh.json<{ tree: { sha: string } }>('GET', `${api}/git/commits/${remotes()[parent]}`)
    const created = await gh.json<{ sha: string }>('POST', `${api}/git/trees`, { base_tree: base.tree.sha, tree: entries })
    const message = messages.length === 1 ? messages[0]! : `agent-factory: ${messages.length} commits\n\n${messages.map((line) => `- ${line}`).join('\n')}`
    const commit = await gh.json<{ sha: string }>('POST', `${api}/git/commits`, { message, parents: [remotes()[parent]], tree: created.sha })
    remember(local, commit.sha)
    return commit.sha
  }

  const branchOf = (name: string, entry: Tree): Branch => {
    const { tree, git } = open(entry.scope)
    const head = () => headOf(entry.scope)
    const commit = async (message: string) => {
      await git('add', '-A')
      if ((await git('status', '--porcelain')).trim() !== '') await git('commit', '-q', '-m', message)
    }
    const existing = (output: string) => nameStatus(output).filter(([status]) => status !== 'D').map(([, path]) => path)
    return {
      name,
      tree,
      head,
      changedFiles: async (from, to) => existing(await git('diff', '--name-status', `${localOf(from)}..${localOf(to)}`)),
      committedFiles: async () => (await git('ls-files')).split('\n').filter(Boolean),
      async pending() {
        // Staging shows new files in the diff. The reset after it keeps run_tests to committed files.
        await git('add', '-A')
        try {
          const names = await git('diff', '--cached', '--name-status')
          return { diff: await git('diff', '--cached', '--no-color'), changed: existing(names), removed: nameStatus(names).filter(([status]) => status === 'D').map(([, path]) => path) }
        } finally {
          await git('reset', '-q')
        }
      },
      commit,
      async merge(ref, message) {
        const writer = treeWriter(tree)
        const source = trees()[ref]
        if (source) {
          // A task branch: its files never overlap another task's, so copying its changes is the merge.
          const from = open(source.scope)
          const changes = nameStatus(await from.git('diff', '--name-status', `${source.start}..${await headOf(source.scope)}`))
          for (const [status, path] of changes) await (status === 'D' ? writer.remove(path) : writer.copy(from.tree, path))
          await commit(message)
          return
        }
        // A commit on GitHub, for example the review loop's fixes on top of this branch's pushed head.
        const pushed = remotes()[await head()]
        if (!pushed) throw new Error(`${name}: push the branch before you merge ${ref}`)
        const compare = await gh.json<{ files?: ChangedFile[] }>('GET', `${api}/compare/${pushed}...${ref}`)
        // The compare lists at most 300 files. A longer list can be incomplete. The tree then differs from the commit.
        if ((compare.files?.length ?? 0) >= compareFileLimit)
          throw new StopError(`${name}: the changes from ${pushed.slice(0, 12)} to ${ref.slice(0, 12)} touch ${compareFileLimit} or more files, more than the compare of GitHub can list`)
        for (const file of compare.files ?? []) {
          if (file.status === 'renamed') await writer.remove(file.previous_filename!)
          if (file.status === 'removed') await writer.remove(file.filename)
          else await restoreFromGitHub(gh, api, tree, file.filename, ref)
        }
        await commit(message)
        remember(await head(), ref)
      },
    }
  }

  return {
    async view(commit) {
      const recorded = ledger.get<string>(`view:${commit}`)
      if (recorded) return open(recorded).tree
      // A crashed download leaves a partial tree: each attempt writes a fresh scope.
      const scope = `view:${options.run}:${commit.slice(0, 12)}:${Date.now()}`
      const { skipped } = await writeTarball(gh, api, open(scope).tree, commit)
      if (skipped.length > 0) options.log(`skipped ${skipped.length} files over the size limit: ${skipped.slice(0, 5).join(', ')}`)
      ledger.put(`view:${commit}`, scope)
      return open(scope).tree
    },
    async branch(name, from) {
      const recorded = trees()[name]
      if (recorded) return branchOf(name, recorded)
      const scope = `branch:${options.run}:${name}:${Date.now()}`
      const target = open(scope)
      const view = ledger.get<string>(`view:${from}`)
      if (view) {
        await copyTree(open(view).tree, target.tree, { git: false })
        await target.git('init', '-q')
        await target.git('add', '-A')
        await target.git('commit', '-q', '-m', `base ${from}`)
        remember(await headOf(scope), from)
      } else {
        const local = localOf(from)
        // The first tree at the commit: the run's dev branch comes before its task branches, and holds no uncommitted builder work.
        let source: Tree | undefined
        for (const entry of Object.values(trees()))
          if ((await headOf(entry.scope)) === local) {
            source = entry
            break
          }
        if (!source) throw new Error(`no branch of the run is at ${from}`)
        await copyTree(open(source.scope).tree, target.tree, { git: true })
      }
      const entry = { scope, start: await headOf(scope) }
      ledger.put('trees', { ...trees(), [name]: entry })
      return branchOf(name, entry)
    },
    async exists(name) {
      if (trees()[name]) return true
      try {
        await gh.json('GET', `${api}/git/ref/heads/${encodePath(name)}`)
        return true
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return false
        throw error
      }
    },
    async push(branch) {
      const entry = trees()[branch.name]
      if (!entry) throw new Error(`${branch.name} is not a branch of this run`)
      const local = await branch.head()
      const sha = remotes()[local] ?? (await createCommit(branch.name, entry.scope, local))
      const pushed = ledger.get<Record<string, string>>('pushed') ?? {}
      if (pushed[branch.name] !== sha) {
        await setRef(branch.name, sha)
        ledger.put('pushed', { ...pushed, [branch.name]: sha })
        options.log(`pushed ${branch.name} at ${sha.slice(0, 12)}`)
      }
      return sha
    },
  }
}
