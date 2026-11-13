import { logTailChars, readCi } from '../core/ci.ts'
import type { PullRequests } from '../core/platform.ts'
import type { GitHub } from './github.ts'

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The PRs and CI of a repository through the GitHub REST and GraphQL APIs. */
export function githubPulls(gh: GitHub, owner: string, repo: string, baseRef: string): PullRequests {
  const api = `/repos/${owner}/${repo}`
  type Pull = { number: number; html_url: string; draft: boolean; node_id: string }
  return {
    async open({ head, title, body }) {
      const open = await gh.json<Pull[]>('GET', `${api}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`)
      const pull = open[0] ?? (await gh.json<Pull>('POST', `${api}/pulls`, { base: baseRef, body, draft: true, head, title }))
      return { number: pull.number, url: pull.html_url }
    },
    async ready(pr) {
      const pull = await gh.json<Pull>('GET', `${api}/pulls/${pr}`)
      if (pull.draft)
        await gh.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', { id: pull.node_id })
    },
    async comment(pr, body) {
      await gh.json('POST', `${api}/issues/${pr}/comments`, { body })
    },
    ci: (sha) => readCi((path) => gh.json('GET', path), api, sha),
    async failureLog(job) {
      if (job.run === null) return `No log: see ${job.url}`
      type Job = { id: number; name: string; conclusion: string | null }
      // The run can be in progress, GitHub can have deleted the log, or the token can have no Actions read permission.
      let jobs: Job[]
      try {
        jobs = (await gh.json<{ jobs: Job[] }>('GET', `${api}/actions/runs/${job.run}/jobs?per_page=100`)).jobs
      } catch (error) {
        return `No log: see ${job.url} (${reason(error)})`.slice(0, logTailChars)
      }
      const logs: string[] = []
      for (const failed of jobs.filter((entry) => entry.conclusion === 'failure')) {
        let log: string
        try {
          log = (await (await gh.raw(`${api}/actions/jobs/${failed.id}/logs`, 'application/vnd.github+json')).text()).slice(-logTailChars)
        } catch (error) {
          log = `No log: see ${job.url} (${reason(error)})`.slice(0, logTailChars)
        }
        logs.push(`### ${failed.name}\n${log}`)
      }
      return logs.join('\n\n') || `No failed job log: see ${job.url}`
    },
  }
}
