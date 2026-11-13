import { logTailChars, readCi } from '../core/ci.ts'
import type { PullRequests } from '../core/platform.ts'
import { gh } from './channels.ts'

/** The PRs and CI of the repository at `repo`, through the gh CLI and its login. */
export function ghPullRequests(repo: string, baseRef: string): PullRequests {
  const run = gh(repo)
  const get = async <T>(path: string) => JSON.parse(await run(['api', path])) as T
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
