import { readCi } from '../core/ci.ts'
import { mergePull } from '../core/merge.ts'
import type { PullRequests } from '../core/platform.ts'
import { gh } from './channels.ts'

const logTailChars = 6_000

/** gh api gives the HTTP status of a failed call only in its error text, for example "... (HTTP 409)". */
const httpStatus = (error: unknown): number | undefined => {
  const status = /\(HTTP (\d{3})\)/.exec(error instanceof Error ? error.message : String(error))?.[1]
  return status === undefined ? undefined : Number(status)
}

/** The PRs and CI of the repository at `repo`, through the gh CLI and its login. */
export function ghPullRequests(repo: string, baseRef: string): PullRequests {
  const run = gh(repo)
  const get = async <T>(path: string) => JSON.parse(await run(['api', path])) as T
  const put = async <T>(path: string, body: Record<string, unknown>) =>
    JSON.parse(await run(['api', path, '--method', 'PUT', ...Object.entries(body).flatMap(([key, value]) => ['-f', `${key}=${value}`])])) as T
  return {
    async open({ head, title, body }) {
      const open = JSON.parse(await run(['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url'])) as { number: number; url: string }[]
      if (open[0]) return open[0]
      const url = (await run(['pr', 'create', '--draft', '--base', baseRef, '--head', head, '--title', title, '--body-file', '-'], body)).trim().split('\n').at(-1)!
      return { number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), url }
    },
    async ready(pr) {
      if ((JSON.parse(await run(['pr', 'view', String(pr), '--json', 'isDraft'])) as { isDraft: boolean }).isDraft) await run(['pr', 'ready', String(pr)])
    },
    // The merge API merges immediately or refuses. gh pr merge can add the PR to a merge queue.
    // The answer gives the merge commit, so the host does not make a second call after the merge.
    merge: (pr, { method, sha }) => mergePull(put, get, `repos/{owner}/{repo}/pulls/${pr}`, method, sha, httpStatus),
    async comment(pr, body) {
      await run(['pr', 'comment', String(pr), '--body-file', '-'], body)
    },
    ci: (sha) => readCi(get, 'repos/{owner}/{repo}', sha),
    async failureLog(job) {
      if (job.run === null) return `No log: see ${job.url}`
      try {
        return (await run(['run', 'view', String(job.run), '--log-failed'])).slice(-logTailChars)
      } catch (error) {
        // The run can still go on, the log can be expired, or the failed check can have no step log.
        return `No log: see ${job.url} (${error instanceof Error ? error.message : String(error)})`.slice(0, logTailChars)
      }
    },
  }
}
