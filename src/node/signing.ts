import type { Signing } from '../core/platform.ts'
import { commitMode, readSignatureRules, signingLine, type GitHubAnswer } from '../core/signing.ts'
import { StopError } from '../core/stop.ts'
import { gh, type Gh } from './channels.ts'
import { git, gitUnattended, type GitCommits } from './git.ts'

const signatureTimeout = 30_000

/** Owner and name of a github.com repository URL: https, ssh:// or scp-like, with or without .git. Null for another host. */
export function githubRepository(url: string): { owner: string; repo: string } | null {
  const match = /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim())
  const [, owner, repo] = match ?? []
  return owner && repo ? { owner, repo } : null
}

/** The URL of origin, or null when the repository has no origin. `git remote get-url` exits with 2 for a missing remote. */
async function originUrl(repo: string): Promise<string | null> {
  try {
    return (await git(repo, 'remote', 'get-url', 'origin')).trim()
  } catch (error) {
    if ((error as { code?: unknown }).code === 2) return null
    throw error
  }
}

/** A GitHub GET through `gh api`. gh puts the HTTP status of a failed call in its message as `(HTTP nnn)`. */
function ghGet(run: Gh): (path: string) => Promise<GitHubAnswer> {
  return async (path) => {
    try {
      return { status: 200, body: JSON.parse(await run(['api', path])) as unknown }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = /\(HTTP (\d{3})\)/.exec(message)
      if (status) return { status: Number(status[1]), body: message }
      throw error
    }
  }
}

/** The signing of the local host. `commits` is the commit mode of the git adapters of this run. */
export function nodeSigning(repo: string, commits: GitCommits, run: Gh = gh(repo)): Signing {
  return {
    async check(branches) {
      const url = await originUrl(repo)
      const github = url === null ? null : githubRepository(url)
      if (!github) return { origin: false, branches: [], mode: 'unsigned' }
      const rules = await readSignatureRules(ghGet(run), `repos/${github.owner}/${github.repo}`, branches)
      return { origin: true, branches: rules, mode: commitMode(rules, { signUnknown: true }) }
    },
    async apply(record) {
      commits.unsigned = record.mode === 'unsigned'
      if (record.mode === 'unsigned') return
      const sign = (await git(repo, 'config', '--type=bool', '--default=false', '--get', 'commit.gpgsign')).trim()
      if (sign !== 'true') {
        // An unreadable classic protection alone can be no requirement, so the run continues. When GitHub requires signatures, it rejects the push.
        if (!record.branches.some((rule) => rule.rulesets.length > 0 || rule.classic === 'required')) return
        throw new StopError(
          `${signingLine(record)}, but commit.gpgsign is off in the git config, so GitHub rejects the unsigned commits of the host. ` +
            'Set commit.gpgsign to true, with gpg.format and user.signingkey that give a key that signs without a prompt.',
        )
      }
      // A commit object of the empty tree with no ref: git signs it with gpg.format, gpg.program and user.signingkey, as each host commit.
      try {
        const empty = (await git(repo, 'hash-object', '-t', 'tree', '/dev/null')).trim()
        await gitUnattended(repo, signatureTimeout, 'commit-tree', '-S', '-m', 'agent-factory signature check', empty)
      } catch (error) {
        const late = (error as { killed?: unknown }).killed === true ? ` (no answer in ${signatureTimeout / 1000} s)` : ''
        throw new StopError(
          `${signingLine(record)}, but git cannot sign a commit${late}. Make sure that gpg.format and user.signingkey in the git config ` +
            `give a key that signs without a prompt. git: ${error instanceof Error ? error.message.trim() : String(error)}`,
        )
      }
    },
  }
}
