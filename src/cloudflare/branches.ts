import type { Contracts } from 'nanocode-ts'
import { SqlFileSystem, type FileSystem } from 'nanocode-ts/bash'
import { systemClock, type Clock } from '../core/clock.ts'
import type { Ledger } from '../core/ledger.ts'
import { markedFiles } from '../core/merge.ts'
import type { Branch, Branches } from '../core/platform.ts'
import { StopError } from '../core/stop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { base64, copyTree, encodePath, nameStatus, restoreFromGitHub, treeGit, treeWriter, writeTarball, type ChangedFile } from './trees.ts'

type Tree = { scope: string; start: string }

async function remoteExists(gh: GitHub, api: string, name: string): Promise<boolean> {
  try {
    await gh.json('GET', `${api}/git/ref/heads/${encodePath(name)}`)
    return true
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false
    throw error
  }
}

/** Deletes a branch on GitHub. A branch that is not there is not an error, but a refused delete is. */
export async function deleteRemoteBranch(gh: GitHub, api: string, name: string): Promise<void> {
  try {
    await gh.json('DELETE', `${api}/git/refs/heads/${encodePath(name)}`)
  } catch (error) {
    if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 422)) throw error
    // GitHub answers 422 for a ref that does not exist. It also answers 422 when it refuses to delete a ref, for example a protected branch.
    if (error.status === 422 && (await remoteExists(gh, api, name))) throw error
  }
}

/**
 * Makes `to` hold only the files of `commit`: a copy of the .git directory of `from`, and then a hard reset to the
 * commit. No work file is copied, so git writes each file of the commit. A copied work file with an uncommitted change
 * can stay after the reset, because git can see it as clean when its size and time stamp agree with the index.
 */
export async function checkoutCommit(from: FileSystem.FileSystem, to: FileSystem.FileSystem, commit: string): Promise<void> {
  const writer = treeWriter(to)
  const walk = async (dir: string) => {
    if (!(await to.stat(dir))) await to.mkdir(dir)
    for (const name of await from.list(dir)) {
      const path = `${dir}/${name}`
      if ((await from.lstat!(path))?.kind === 'directory') await walk(path)
      else await writer.copy(from, path.slice(1))
    }
  }
  await walk('/.git')
  await treeGit(to)('reset', '-q', '--hard', commit)
}

/**
 * A tree of the files of a local commit of a run branch, from the first branch tree that has the commit. The ledger
 * keeps the scope of each complete tree, so a resume does not copy again.
 */
export async function commitTree(options: { sql: Contracts.SqlHost; ledger: Ledger; run: string }, commit: string): Promise<FileSystem.FileSystem> {
  const { ledger } = options
  const key = `commit-tree:${commit}`
  const recorded = ledger.get<string>(key)
  if (recorded) return SqlFileSystem.create(options.sql, { scope: recorded })
  for (const entry of Object.values(ledger.get<Record<string, Tree>>('trees') ?? {})) {
    const from = SqlFileSystem.create(options.sql, { scope: entry.scope })
    if (!(await treeGit(from)('log', '--format=%H')).split('\n').includes(commit)) continue
    // A crashed copy leaves a partial tree: each attempt writes a fresh scope.
    const scope = `commit:${options.run}:${commit.slice(0, 12)}:${Date.now()}`
    const tree = SqlFileSystem.create(options.sql, { scope })
    await checkoutCommit(from, tree, commit)
    ledger.put(key, scope)
    return tree
  }
  throw new Error(`no branch of the run has the commit ${commit}`)
}

/**
 * The tree with a mkdir that also makes the missing parents and accepts a directory that exists, as the disk tree of the
 * Node host does. The workflows rely on it, for example for /prereg in a notebook that has it.
 */
function mkdirAll(tree: SqlFileSystem.SqlFileSystem): SqlFileSystem.SqlFileSystem {
  return {
    ...tree,
    async mkdir(path) {
      let dir = ''
      for (const part of path.split('/').filter(Boolean)) {
        dir += `/${part}`
        if ((await tree.stat(dir))?.kind !== 'directory') await tree.mkdir(dir)
      }
    },
  }
}

/** The most files that the compare of GitHub lists. */
const compareFileLimit = 300

/** Every path that a file of a compare touches: its path, and the old path of a rename. */
const comparePaths = (files: ChangedFile[]) => [...new Set(files.flatMap((file) => [...(file.previous_filename ? [file.previous_filename] : []), file.filename]))]

/** A file of a compare as name-status pairs, as `nameStatus` gives them: a rename gives its old path as a deletion. */
const compareStatus = (file: ChangedFile): [string, string][] =>
  file.status === 'renamed' ? [['D', file.previous_filename!], ['A', file.filename]] : [[file.status === 'removed' ? 'D' : 'M', file.filename]]

/**
 * A base merge with a conflict, until the push that creates its GitHub merge commit. `parent` is the base commit, the
 * second parent of that commit. `finished` is true after finishMerge, and `created` is the GitHub merge commit.
 */
type Merging = { parent: string; message: string; finished?: boolean; created?: string }

/**
 * A clean base merge that GitHub made, until the local commit records it. A retry after a failure finishes it and does
 * not merge again. `local` and `from` are the local head and the pushed head before the merge, `sha` is the merge commit.
 */
type BaseMerged = { local: string; from: string; sha: string; files: string[] }

/**
 * The branches of a development run in Durable Object SQL: one tree for each branch, with in-process git. A new
 * branch copies the tree of its start commit, .git included, so that commit IDs agree across branches. Pushes go
 * to GitHub through the Git Data API, so no token ever reaches the build machine. The ledger maps local commits to
 * their GitHub commits.
 */
export function sqlBranches(options: { gh: GitHub; owner: string; repo: string; sql: Contracts.SqlHost; ledger: Ledger; run: string; clock?: Clock; log(line: string): void }): Branches {
  const { gh, ledger } = options
  const clock = options.clock ?? systemClock
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
  const mergings = () => ledger.get<Record<string, Merging>>('merging') ?? {}
  const baseMerges = () => ledger.get<Record<string, BaseMerged>>('base-merged') ?? {}
  const remoteHead = async (ref: string) => (await gh.json<{ object: { sha: string } }>('GET', `${api}/git/ref/heads/${encodePath(ref)}`)).object.sha

  /** The compare of GitHub from `from` to `to`. A list of 300 files or more can be incomplete, so it stops the run. */
  const compare = async (name: string, from: string, to: string) => {
    const result = await gh.json<{ files?: ChangedFile[]; merge_base_commit: { sha: string } }>('GET', `${api}/compare/${from}...${to}`)
    if ((result.files?.length ?? 0) >= compareFileLimit)
      throw new StopError(`${name}: the changes from ${from.slice(0, 12)} to ${to.slice(0, 12)} touch ${compareFileLimit} or more files, more than the compare of GitHub can list`)
    return result
  }

  const setRef = async (name: string, sha: string) => {
    try {
      await gh.json('POST', `${api}/git/refs`, { ref: `refs/heads/${name}`, sha })
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error
      await gh.json('PATCH', `${api}/git/refs/heads/${encodePath(name)}`, { force: false, sha })
    }
  }

  /**
   * Creates the GitHub commit of a local commit: one commit for every local commit since the last pushed one. With
   * `merge`, it is the merge commit of a base merge, also when the local commit is on GitHub already.
   */
  const createCommit = async (name: string, scope: string, local: string, merge?: Merging): Promise<string> => {
    const { tree, git } = open(scope)
    const hashes = (await git('log', '--format=%H')).split('\n').filter(Boolean)
    const subjects = (await git('log', '--format=%s')).split('\n')
    const parent = hashes.find((hash) => (hash !== local || merge) && remotes()[hash])
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
    const created = entries.length === 0 ? base.tree : await gh.json<{ sha: string }>('POST', `${api}/git/trees`, { base_tree: base.tree.sha, tree: entries })
    const message = merge
      ? merge.message
      : messages.length === 1
        ? messages[0]!
        : `agent-factory: ${messages.length} commits\n\n${messages.map((line) => `- ${line}`).join('\n')}`
    const parents = [remotes()[parent]!, ...(merge ? [merge.parent] : [])]
    const commit = await gh.json<{ sha: string }>('POST', `${api}/git/commits`, { message, parents, tree: created.sha })
    remember(local, commit.sha)
    if (merge) ledger.put('merging', { ...mergings(), [name]: { ...merge, created: commit.sha } })
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
    /**
     * The name-status pairs from `from` to `to`. A `from` without a local commit, for example a merge base on the base
     * branch, gives the compare of GitHub up to the last pushed commit, and then the local diff after that commit.
     */
    const changes = async (from: string, to: string): Promise<[string, string][]> => {
      const [start, end] = [localOf(from), localOf(to)]
      const hashes = (await git('log', '--format=%H')).split('\n').filter(Boolean)
      if (hashes.includes(start) || !hashes.includes(end)) return nameStatus(await git('diff', '--name-status', `${start}..${end}`))
      // The local history is linear: the commits after `end` in the log are its ancestors.
      const pushed = hashes.slice(hashes.indexOf(end)).find((hash) => remotes()[hash])
      if (!pushed) throw new Error(`${name}: no commit up to ${to.slice(0, 12)} is on GitHub`)
      const local = nameStatus(await git('diff', '--name-status', `${pushed}..${end}`))
      const later = new Set(local.map(([, path]) => path))
      const remote = ((await compare(name, from, remotes()[pushed]!)).files ?? []).flatMap(compareStatus)
      return [...remote.filter(([, path]) => !later.has(path)), ...local]
    }
    /** Writes the files of a compare to the tree, as they are in GitHub commit `ref`, as merge() does for review fixes. */
    const restore = async (files: ChangedFile[], ref: string) => {
      const writer = treeWriter(tree)
      for (const file of files) {
        if (file.status === 'renamed') await writer.remove(file.previous_filename!)
        if (file.status === 'removed') await writer.remove(file.filename)
        else await restoreFromGitHub(gh, api, tree, file.filename, ref)
      }
    }
    /** Writes the GitHub merge commit of a clean base merge to the tree, and records that the local commit stands for it. */
    const finishBaseMerge = async (done: BaseMerged, message: string) => {
      // A failure after the local commit leaves only the records to write.
      if ((await head()) === done.local) {
        await restore((await compare(name, done.from, done.sha)).files ?? [], done.sha)
        await commit(message)
      }
      remember(await head(), done.sha)
      ledger.put('pushed', { ...(ledger.get<Record<string, string>>('pushed') ?? {}), [name]: done.sha })
      ledger.put('base-merged', Object.fromEntries(Object.entries(baseMerges()).filter(([key]) => key !== name)))
      return { files: done.files, conflicts: [] }
    }
    /**
     * Without a 3-way merge in process: each file that both sides changed since the merge base gets whole-file conflict
     * markers, and the files of only the base come from `target`. The ledger keeps `target` for the push.
     */
    const conflict = async (target: string, message: string, mergeBase: string, pushed: string, incoming: ChangedFile[]): Promise<string[]> => {
      const ours = new Set(comparePaths((await compare(name, mergeBase, pushed)).files ?? []))
      const conflicts = comparePaths(incoming).filter((path) => ours.has(path))
      const theirs = new Set(incoming.filter((file) => file.status !== 'removed').map((file) => file.filename))
      const text = (bytes: Uint8Array) => {
        const value = new TextDecoder().decode(bytes)
        return value === '' || value.endsWith('\n') ? value : `${value}\n`
      }
      const writer = treeWriter(tree)
      for (const path of conflicts) {
        const url = `${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(target)}`
        const mine = (await tree.stat(`/${path}`)) ? text(await tree.read(`/${path}`)) : ''
        const other = theirs.has(path) ? text(new Uint8Array(await (await gh.raw(url, 'application/vnd.github.raw')).arrayBuffer())) : ''
        await writer.write(path, new TextEncoder().encode(`<<<<<<< ${name}\n${mine}=======\n${other}>>>>>>> ${target.slice(0, 12)}\n`))
      }
      const conflicted = (file: ChangedFile) => conflicts.includes(file.filename) || (file.previous_filename !== undefined && conflicts.includes(file.previous_filename))
      await restore(incoming.filter((file) => !conflicted(file)), target)
      ledger.put('merging', { ...mergings(), [name]: { message, parent: target } })
      return conflicts
    }
    return {
      name,
      tree: mkdirAll(tree),
      head,
      changedFiles: async (from, to) => (await changes(from, to)).filter(([status]) => status !== 'D').map(([, path]) => path),
      touchedFiles: async (from, to) => [...new Set((await changes(from, to)).map(([, path]) => path))],
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
      async mergeBaseWith(target) {
        const pushed = remotes()[await head()]
        // A finished base merge has no GitHub commit until the push, so its merge base is not known yet.
        if (!pushed || mergings()[name]?.finished) throw new Error(`${name}: push the branch before you compare it with ${target}`)
        return (await compare(name, pushed, target)).merge_base_commit.sha
      },
      async mergeCommit(target, message) {
        const local = await head()
        const pushed = remotes()[local]
        const done = baseMerges()[name]
        // GitHub made this merge before a failure: finish it, and do not merge again.
        if (done && (local === done.local || !pushed) && (await remoteHead(name)) === done.sha) return finishBaseMerge(done, message)
        if (!pushed) throw new Error(`${name}: push the branch before you merge ${target}`)
        // GitHub merges into its branch head. A commit there that the run did not push stops the merge: no force.
        const current = await remoteHead(name)
        if (current !== pushed) throw new Error(`${name}: GitHub has the head ${current.slice(0, 12)}, not the pushed head ${pushed.slice(0, 12)}`)
        const mergeBase = (await compare(name, pushed, target)).merge_base_commit.sha
        const incoming = (await compare(name, mergeBase, target)).files ?? []
        const files = comparePaths(incoming)
        let merged: { sha: string } | undefined
        try {
          merged = await gh.json<{ sha: string } | undefined>('POST', `${api}/merges`, { base: name, commit_message: message, head: target })
        } catch (error) {
          if (!(error instanceof GitHubError) || error.status !== 409) throw error
          return { files, conflicts: await conflict(target, message, mergeBase, pushed, incoming) }
        }
        // HTTP 204: the branch has the commit already.
        if (!merged) return { files, conflicts: [] }
        const record = { local, from: pushed, sha: merged.sha, files }
        ledger.put('base-merged', { ...baseMerges(), [name]: record })
        return finishBaseMerge(record, message)
      },
      async finishMerge(files, message) {
        const marked = await markedFiles(tree, files)
        const merge = mergings()[name]
        if (marked.length > 0 || !merge || merge.finished) return marked
        // The push makes the GitHub merge commit, with the base commit as its second parent.
        await commit(message)
        ledger.put('merging', { ...mergings(), [name]: { ...merge, finished: true, message } })
        return []
      },
    }
  }

  return {
    async view(commit) {
      const recorded = ledger.get<string>(`view:${commit}`)
      if (recorded) return open(recorded).tree
      // A crashed download leaves a partial tree: each attempt writes a fresh scope.
      const scope = `view:${options.run}:${commit.slice(0, 12)}:${clock.now()}`
      const { skipped } = await writeTarball(gh, api, open(scope).tree, commit)
      if (skipped.length > 0) options.log(`skipped ${skipped.length} files over the size limit: ${skipped.slice(0, 5).join(', ')}`)
      ledger.put(`view:${commit}`, scope)
      return open(scope).tree
    },
    async branch(name, from) {
      const recorded = trees()[name]
      if (recorded) return branchOf(name, recorded)
      const scope = `branch:${options.run}:${name}:${clock.now()}`
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
      return Boolean(trees()[name]) || (await remoteExists(gh, api, name))
    },
    remoteHead,
    async push(branch) {
      const entry = trees()[branch.name]
      if (!entry) throw new Error(`${branch.name} is not a branch of this run`)
      const local = await branch.head()
      const recorded = remotes()[local]
      // A base merge with a conflict needs its GitHub merge commit, also when the local head is on GitHub already.
      const merge = mergings()[branch.name]
      const sha = recorded && (!merge || merge.created === recorded) ? recorded : await createCommit(branch.name, entry.scope, local, merge)
      const pushed = ledger.get<Record<string, string>>('pushed') ?? {}
      if (pushed[branch.name] !== sha) {
        await setRef(branch.name, sha)
        ledger.put('pushed', { ...pushed, [branch.name]: sha })
        options.log(`pushed ${branch.name} at ${sha.slice(0, 12)}`)
      }
      if (merge) ledger.put('merging', Object.fromEntries(Object.entries(mergings()).filter(([name]) => name !== branch.name)))
      return sha
    },
    deleteRemote: (name) => deleteRemoteBranch(gh, api, name),
    // The SQL trees are Durable Object data of the run, and they stay. No local branch or worktree exists to remove.
    deleteLocal: async () => {},
    release: async () => {},
  }
}
