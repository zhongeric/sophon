import type { Contracts } from 'nanocode-ts'
import { Bash, MemoryFileSystem, Mount, SqlFileSystem } from 'nanocode-ts/bash'
import type { Ledger } from '../core/ledger.ts'
import type { Frozen, Repo } from '../core/platform.ts'
import { StopError } from '../core/stop.ts'
import { GitHubError, type GitHub } from './github.ts'
import { gunzip, untar, type TarEntry } from './tar.ts'

export type PullRequest = { owner: string; repo: string; pr: number }

/** The PR head as GitHub knows it, and the two local commits that stand for the merge base and the head. */
type Snapshot = { headSha: string; headRef: string; mergeBase: string; localBase: string; localHead: string }

export type GitHubRepo = Repo & {
  /** Commits the fixes since the freeze to the run's branch on GitHub. Returns the PR head when there are no fixes. */
  publish(): Promise<string>
}

type PullView = { head: { sha: string; ref: string }; base: { ref: string }; draft: boolean; node_id: string }
type Compare = { merge_base_commit: { sha: string } }
type ChangedFile = { filename: string; status: string; previous_filename?: string }
type Contents = { type: 'file' | 'symlink' | 'dir' | 'submodule'; target?: string }

/** GitHub lists at most this many files of a pull request. */
const maxPullFiles = 3000
const pageSize = 100

const identity = ['-c', 'user.name=agent-factory', '-c', 'user.email=agent-factory@users.noreply.github.com', '-c', 'core.quotePath=false']
/** Host git over a whole repository can take long, beyond the agents' 30-second shell limit. */
const gitTimeoutMs = 10 * 60_000
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/** Name-status lines as [status, path] pairs; a rename gives its old path as a deletion. */
function nameStatus(output: string): [string, string][] {
  return output
    .split('\n')
    .filter(Boolean)
    .flatMap((line): [string, string][] => {
      const [status = '', ...paths] = line.split('\t')
      return status.startsWith('R') ? [['D', paths[0]!], ['A', paths[1]!]] : [[status[0]!, paths[0]!]]
    })
}

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
  let shell: Promise<Bash.Bash> | undefined

  const git = async (...args: string[]) => {
    shell ??= Bash.create({
      cwd: '/repo',
      fetch: async () => {
        throw new Error('network access is off')
      },
      fs: Mount.create(MemoryFileSystem.create(), { mounts: { '/repo': tree } }),
      limits: { timeoutMs: gitTimeoutMs },
    })
    const result = await (await shell).exec(['git', ...identity, ...args].map(quote).join(' '))
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr || result.stdout}`)
    return result.stdout
  }
  const head = async () => (await git('rev-parse', 'HEAD')).trim()
  const snapshot = () => {
    const recorded = ledger.get<Snapshot>('snapshot')
    if (!recorded) throw new Error('the repository is not frozen')
    return recorded
  }

  const parents = (path: string) => {
    const parts = path.split('/').slice(0, -1)
    return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
  }
  const remove = (path: string) => tree.remove(`/${path}`).catch(() => undefined)
  const makeParents = async (path: string) => {
    for (const dir of parents(path)) if (!(await tree.stat(dir))) await tree.mkdir(dir)
  }
  /** Writes replace the path itself, so a write never follows a symlink that the snapshot holds. */
  const write = async (path: string, data: Uint8Array, mode = 0o644) => {
    await remove(path)
    await makeParents(path)
    await tree.write(`/${path}`, data)
    if (mode & 0o111) await tree.chmod(`/${path}`, 0o755)
  }
  const link = async (path: string, target: string) => {
    await remove(path)
    await makeParents(path)
    await tree.symlink(target, `/${path}`)
  }
  const restore = async (entry: TarEntry) => {
    if (entry.type === 'symlink') await link(entry.path, entry.target)
    else if (entry.type === 'file') await write(entry.path, entry.data, entry.mode)
  }
  /** The merge-base version of a path. The raw contents API follows symlinks, so ask for the entry type first. */
  const restoreBase = async (path: string, ref: string) => {
    const url = `${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
    const entry = await gh.json<Contents>('GET', url)
    if (entry.type === 'symlink') await link(path, entry.target ?? '')
    else if (entry.type === 'file') await write(path, new Uint8Array(await (await gh.raw(url, 'application/vnd.github.raw')).arrayBuffer()))
    else await remove(path)
  }
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
      const archive = await gh.raw(`${api}/tarball/${view.head.sha}`, 'application/vnd.github+json')
      const entries = untar(await gunzip(archive.body!), 1)

      // A crashed freeze leaves a partial tree: start each attempt in a fresh scope.
      scope = `tree:${options.runId}:${Date.now()}`
      ledger.put('tree-scope', scope)
      tree = SqlFileSystem.create(options.sql, { scope })
      shell = undefined
      const skipped: string[] = []
      for (const entry of entries) {
        if (entry.type === 'file' && entry.data.length > tree.maxFileBytes) skipped.push(entry.path)
        else await restore(entry)
      }
      if (skipped.length > 0) options.log(`skipped ${skipped.length} files over ${tree.maxFileBytes} bytes: ${skipped.slice(0, 5).join(', ')}`)

      const byPath = new Map(entries.map((entry) => [entry.path, entry]))
      for (const file of files) {
        if (file.status === 'added' || file.status === 'copied') await remove(file.filename)
        else if (file.status === 'renamed') {
          await remove(file.filename)
          await restoreBase(file.previous_filename!, mergeBase)
        } else await restoreBase(file.filename, mergeBase)
      }
      await git('init', '-q')
      await git('add', '-A')
      await git('commit', '-q', '-m', `merge base ${mergeBase}`)
      const localBase = await head()
      for (const file of files) {
        if (file.status === 'renamed') await remove(file.previous_filename!)
        const entry = byPath.get(file.filename)
        if (file.status === 'removed' || !entry) await remove(file.filename)
        else await restore(entry)
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
