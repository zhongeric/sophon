import type { Contracts } from 'nanocode-ts'
import { SqlFileSystem } from 'nanocode-ts/bash'
import type { Ledger } from '../core/ledger.ts'
import type { Frozen, Repo } from '../core/platform.ts'
import { StopError } from '../core/stop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { base64, encodePath, nameStatus, restoreFromGitHub, treeGit, treeWriter, writeTarball, type ChangedFile } from './trees.ts'

export type PullRequest = { owner: string; repo: string; pr: number }

/** The PR head as GitHub knows it, and the two local commits that stand for the merge base and the head. */
type Snapshot = { headSha: string; headRef: string; mergeBase: string; localBase: string; localHead: string }

export type GitHubRepo = Repo & {
  /** Commits the fixes since the freeze to the run's branch on GitHub. Returns the PR head when there are no fixes. */
  publish(): Promise<string>
}

type PullView = { head: { sha: string; ref: string }; base: { ref: string }; draft: boolean; node_id: string }
type Compare = { merge_base_commit: { sha: string } }

/** GitHub lists at most this many files of a pull request. */
const maxPullFiles = 3000
const pageSize = 100

/**
 * A PR's repository in Durable Object SQL. The freeze writes the head snapshot, steps the PR's files back
 * to the merge base for a first commit, then forward for a second, so in-process git diffs both ways.
 * Fixes go back to GitHub through the Git Data API. In-process git reads symlinks as their targets'
 * content, so a PR that only retargets a symlink shows no change.
 */
export function githubRepo(options: {
  gh: GitHub
  pull: PullRequest
  sql: Contracts.SqlHost
  ledger: Ledger
  runId: string
  branch: string
  log(line: string): void
}): GitHubRepo {
  const { gh, pull, ledger } = options
  const api = `/repos/${pull.owner}/${pull.repo}`
  let scope = ledger.get<string>('tree-scope') ?? `tree:${options.runId}`
  let tree = SqlFileSystem.create(options.sql, { scope })
  let git = treeGit(tree)
  const head = async () => (await git('rev-parse', 'HEAD')).trim()
  const snapshot = () => {
    const recorded = ledger.get<Snapshot>('snapshot')
    if (!recorded) throw new Error('the repository is not frozen')
    return recorded
  }

  const remove = (path: string) => treeWriter(tree).remove(path)
  const changedFiles = async () => {
    const files: ChangedFile[] = []
    for (let page = 1; ; page++) {
      const batch = await gh.json<ChangedFile[]>('GET', `${api}/pulls/${pull.pr}/files?per_page=${pageSize}&page=${page}`)
      files.push(...batch)
      if (batch.length < pageSize) break
    }
    if (files.length >= maxPullFiles) throw new StopError(`the PR changes ${maxPullFiles} or more files, the most that GitHub lists. Split it to review it.`)
    return files
  }
  let publish: () => Promise<string>

  return {
    get tree() {
      return tree
    },

    async freeze(): Promise<Frozen> {
      const view = await gh.json<PullView>('GET', `${api}/pulls/${pull.pr}`)
      const compare = await gh.json<Compare>('GET', `${api}/compare/${encodeURIComponent(view.base.ref)}...${view.head.sha}`)
      const mergeBase = compare.merge_base_commit.sha
      const files = await changedFiles()

      // A crashed freeze leaves a partial tree: start each attempt in a fresh scope.
      scope = `tree:${options.runId}:${Date.now()}`
      ledger.put('tree-scope', scope)
      tree = SqlFileSystem.create(options.sql, { scope })
      git = treeGit(tree)
      const { entries, skipped } = await writeTarball(gh, api, tree, view.head.sha)
      if (skipped.length > 0) options.log(`skipped ${skipped.length} files over ${tree.maxFileBytes} bytes: ${skipped.slice(0, 5).join(', ')}`)

      const byPath = new Map(entries.map((entry) => [entry.path, entry]))
      for (const file of files) {
        if (file.status === 'added' || file.status === 'copied') await remove(file.filename)
        else if (file.status === 'renamed') {
          await remove(file.filename)
          await restoreFromGitHub(gh, api, tree, file.previous_filename!, mergeBase)
        } else await restoreFromGitHub(gh, api, tree, file.filename, mergeBase)
      }
      await git('init', '-q')
      await git('add', '-A')
      await git('commit', '-q', '-m', `merge base ${mergeBase}`)
      const localBase = await head()
      for (const file of files) {
        if (file.status === 'renamed') await remove(file.previous_filename!)
        const entry = byPath.get(file.filename)
        if (file.status === 'removed' || !entry) await remove(file.filename)
        else await treeWriter(tree).restore(entry)
      }
      await git('add', '-A')
      if ((await git('status', '--porcelain')).trim() !== '') await git('commit', '-q', '-m', `head ${view.head.sha}`)
      const localHead = await head()
      ledger.put('snapshot', { headSha: view.head.sha, headRef: view.head.ref, mergeBase, localBase, localHead } satisfies Snapshot)
      return { base: localBase, head: localHead, branch: options.branch, location: `${pull.owner}/${pull.repo}#${pull.pr} at ${view.head.sha.slice(0, 12)}` }
    },

    diff: (from, to) => git('diff', '--no-color', `${from}..${to}`),
    async changedFiles(from, to) {
      return nameStatus(await git('diff', '--name-status', `${from}..${to}`))
        .filter(([status]) => status !== 'D')
        .map(([, path]) => path)
    },
    async touchedFiles(from, to) {
      return [...new Set(nameStatus(await git('diff', '--name-status', `${from}..${to}`)).map(([, path]) => path))]
    },
    async committedFiles() {
      return (await git('ls-files')).split('\n').filter(Boolean)
    },
    async commit(message) {
      await git('add', '-A')
      if ((await git('status', '--porcelain')).trim() !== '') await git('commit', '-q', '-m', message)
    },
    head,

    publish: (publish = async () => {
      const frozen = snapshot()
      const local = await head()
      if (local === frozen.localHead) return frozen.headSha
      const recorded = ledger.get<{ local: string; sha: string }>('published')
      if (recorded?.local === local) return recorded.sha
      const entries: { path: string; mode: string; type: 'blob'; sha: string | null }[] = []
      for (const [status, path] of nameStatus(await git('diff', '--name-status', `${frozen.localHead}..${local}`))) {
        // In-process git reads through symlinks. Agents cannot write them, so the fixes never change one.
        if ((await tree.lstat(`/${path}`))?.kind === 'symlink') continue
        if (status === 'D') {
          entries.push({ path, mode: '100644', type: 'blob', sha: null })
          continue
        }
        const data = await tree.read(`/${path}`)
        const blob = await gh.json<{ sha: string }>('POST', `${api}/git/blobs`, { content: base64(data), encoding: 'base64' })
        const executable = ((await tree.stat(`/${path}`))?.mode ?? 0) & 0o111
        entries.push({ path, mode: executable ? '100755' : '100644', type: 'blob', sha: blob.sha })
      }
      const parent = await gh.json<{ tree: { sha: string } }>('GET', `${api}/git/commits/${frozen.headSha}`)
      const created = await gh.json<{ sha: string }>('POST', `${api}/git/trees`, { base_tree: parent.tree.sha, tree: entries })
      const commit = await gh.json<{ sha: string }>('POST', `${api}/git/commits`, {
        message: `agent-factory: review fixes (${options.runId})`,
        parents: [frozen.headSha],
        tree: created.sha,
      })
      try {
        await gh.json('POST', `${api}/git/refs`, { ref: `refs/heads/${options.branch}`, sha: commit.sha })
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422) throw error
        await gh.json('PATCH', `${api}/git/refs/heads/${encodePath(options.branch)}`, { force: true, sha: commit.sha })
      }
      ledger.put('published', { local, sha: commit.sha })
      options.log(`published the fixes as ${commit.sha.slice(0, 12)} on ${options.branch}`)
      return commit.sha
    }),

    async ship({ pr, headRef }) {
      const sha = await publish()
      if (sha !== snapshot().headSha) await gh.json('PATCH', `${api}/git/refs/heads/${encodePath(headRef)}`, { force: false, sha })
      const view = await gh.json<PullView>('GET', `${api}/pulls/${pr}`)
      if (view.draft)
        await gh.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', { id: view.node_id })
    },
  }
}
