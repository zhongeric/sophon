/** One CI job of a commit: a GitHub Actions workflow run, or a commit status. `created` is when GitHub created it. */
export type CiJob = { name: string; url: string; done: boolean; ok: boolean; run: number | null; created: string }

type WorkflowRun = { id: number; workflow_id: number; event: string; name: string; status: string; conclusion: string | null; html_url: string; created_at: string }
type Status = { context: string; state: string; target_url: string | null; created_at: string }

/** The most characters of a failed CI log that a builder gets. */
export const logTailChars = 6_000

const passing = new Set(['success', 'neutral', 'skipped'])
const pageSize = 100

/**
 * The CI of a commit on GitHub: the latest Actions run of each workflow and event, and the commit statuses.
 * Fine-grained tokens cannot call the Checks API, so this reads workflow runs instead. `api` is the
 * repository's API path, for example /repos/owner/repo.
 */
export async function readCi(get: <T>(path: string) => Promise<T>, api: string, sha: string): Promise<CiJob[]> {
  const runs: WorkflowRun[] = []
  for (let page = 1; ; page++) {
    const batch = await get<{ total_count: number; workflow_runs: WorkflowRun[] }>(`${api}/actions/runs?head_sha=${sha}&per_page=${pageSize}&page=${page}`)
    runs.push(...batch.workflow_runs)
    if (batch.workflow_runs.length < pageSize || runs.length >= batch.total_count) break
  }
  // A workflow that ran again for the same commit and event counts once, with its latest run.
  const latest = new Map<string, WorkflowRun>()
  for (const run of runs) {
    const key = `${run.workflow_id}:${run.event}`
    if ((latest.get(key)?.id ?? -1) < run.id) latest.set(key, run)
  }
  const statuses = (await get<{ statuses: Status[] }>(`${api}/commits/${sha}/status`)).statuses
  return [
    ...[...latest.values()].map((run) => ({
      name: `${run.name} (${run.event})`,
      url: run.html_url,
      done: run.status === 'completed',
      ok: passing.has(run.conclusion ?? ''),
      run: run.id,
      created: run.created_at,
    })),
    ...statuses.map((status) => ({
      name: status.context,
      url: status.target_url ?? '',
      done: status.state !== 'pending',
      ok: status.state === 'success',
      run: null,
      created: status.created_at,
    })),
  ]
}
