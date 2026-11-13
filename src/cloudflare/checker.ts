import type { CheckResult } from '../core/checks.ts'
import type { Ledger } from '../core/ledger.ts'
import type { Checker } from '../core/platform.ts'
import { PausedError } from '../core/questions.ts'
import type { GitHub } from './github.ts'
import type { GitHubRepo, PullRequest } from './repo.ts'

type WorkflowRun = { id: number; workflow_id: number; event: string; name: string; status: string; conclusion: string | null; html_url: string }
type Status = { context: string; state: string; target_url: string | null }

const passing = new Set(['success', 'neutral', 'skipped'])
const pageSize = 100

/**
 * The repository's own CI as the checks: the fixes go to the run's branch, and the run waits for the GitHub
 * Actions workflow runs and the commit statuses of that commit. Fine-grained tokens cannot call the Checks API,
 * so the run reads workflow runs instead. CI runs the full suite, so the run never runs tests itself.
 */
export function ciChecker(options: { gh: GitHub; pull: PullRequest; repo: GitHubRepo; ledger: Ledger; branch: string; timeoutMs: number }): Checker {
  const api = `/repos/${options.pull.owner}/${options.pull.repo}`
  const workflowRuns = async (sha: string) => {
    const runs: WorkflowRun[] = []
    for (let page = 1; ; page++) {
      const batch = await options.gh.json<{ total_count: number; workflow_runs: WorkflowRun[] }>(
        'GET',
        `${api}/actions/runs?head_sha=${sha}&per_page=${pageSize}&page=${page}`,
      )
      runs.push(...batch.workflow_runs)
      if (batch.workflow_runs.length < pageSize || runs.length >= batch.total_count) break
    }
    // A workflow that ran again for the same commit and event counts once, with its latest run.
    const latest = new Map<string, WorkflowRun>()
    for (const run of runs) {
      const key = `${run.workflow_id}:${run.event}`
      if ((latest.get(key)?.id ?? -1) < run.id) latest.set(key, run)
    }
    return [...latest.values()]
  }
  return {
    tests: null,
    async checks(): Promise<CheckResult[]> {
      const sha = await options.repo.publish()
      const startedKey = `ci-started:${sha}`
      const started = options.ledger.get<number>(startedKey) ?? Date.now()
      options.ledger.put(startedKey, started)
      const runs = await workflowRuns(sha)
      const statuses = (await options.gh.json<{ statuses: Status[] }>('GET', `${api}/commits/${sha}/status`)).statuses
      const results = [
        ...runs.map((run) => ({ name: `${run.name} (${run.event})`, url: run.html_url, done: run.status === 'completed', ok: passing.has(run.conclusion ?? '') })),
        ...statuses.map((status) => ({ name: status.context, url: status.target_url ?? '', done: status.state !== 'pending', ok: status.state === 'success' })),
      ]
      const waited = Date.now() - started
      if (results.length === 0 && waited < options.timeoutMs) throw new PausedError(`waiting for CI to start on ${sha.slice(0, 12)} (${options.branch})`)
      if (results.length === 0)
        return [
          {
            name: 'ci',
            command: '',
            status: 'fail',
            exit_code: null,
            output: `no CI ran on ${sha} in ${Math.round(waited / 60_000)} minutes. Run CI on pushes to factory/** branches.`,
          },
        ]
      const pending = results.filter((result) => !result.done)
      if (pending.length > 0) throw new PausedError(`waiting for CI on ${sha.slice(0, 12)}: ${pending.map((result) => result.name).join(', ')}`)
      return results.map((result) => ({ name: result.name, command: result.url, status: result.ok ? 'pass' : 'fail', exit_code: null, output: '' }))
    },
  }
}
