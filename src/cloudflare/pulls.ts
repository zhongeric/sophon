import { failureExcerpt, readCi } from '../core/ci.ts'
import { mergePull } from '../core/merge.ts'
import type { PullRequests } from '../core/platform.ts'
import { GitHubError, type GitHub } from './github.ts'

const logTailChars = 6_000

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
    merge: (pr, { method, sha }) =>
      mergePull(
        (path, body) => gh.json('PUT', path, body),
        (path) => gh.json('GET', path),
        `${api}/pulls/${pr}`,
        method,
        sha,
        (error) => (error instanceof GitHubError ? error.status : undefined),
      ),
    async comment(pr, body) {
      await gh.json('POST', `${api}/issues/${pr}/comments`, { body })
    },
    ci: (sha) => readCi((path) => gh.json('GET', path), api, sha),
    async failureLog(job) {
      if (job.run === null) return `No log: see ${job.url}`
      type Job = { id: number; name: string; conclusion: string | null }
      const { jobs } = await gh.json<{ jobs: Job[] }>('GET', `${api}/actions/runs/${job.run}/jobs?per_page=100`)
      const logs: string[] = []
      for (const failed of jobs.filter((entry) => entry.conclusion === 'failure'))
        logs.push(`### ${failed.name}\n${failureExcerpt(await (await gh.raw(`${api}/actions/jobs/${failed.id}/logs`, 'application/vnd.github+json')).text(), logTailChars)}`)
      return logs.join('\n\n') || `No failed job log: see ${job.url}`
    },
    async rerunFailedJobs(run) {
      try {
        await gh.json('POST', `${api}/actions/runs/${run}/rerun-failed-jobs`)
        return { started: true }
      } catch (error) {
        // Without Actions write, GitHub refuses the rerun with 403. That refusal is a result, so it never stops the run as
        // a refused credential. A rate limit stays an error.
        if (!(error instanceof GitHubError) || error.status !== 403 || error.rateLimited) throw error
        return { started: false, reason: error.message }
      }
    },
  }
}
