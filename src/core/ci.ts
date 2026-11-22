/**
 * One CI job of a commit: a GitHub Actions workflow run, or a commit status. `created` is when GitHub created it.
 * `attempt` is the attempt of a run, which a rerun increases. A commit status, and a job of an older ledger, has none,
 * which counts as 1.
 */
export type CiJob = { name: string; url: string; done: boolean; ok: boolean; run: number | null; created: string; attempt?: number }

type WorkflowRun = { id: number; workflow_id: number; event: string; name: string; status: string; conclusion: string | null; html_url: string; created_at: string; run_attempt?: number }
type Status = { context: string; state: string; target_url: string | null; created_at: string }

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
      attempt: run.run_attempt ?? 1,
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

const failureMarker = /not ok|##\[error\]|FAIL|Error:/
const blockLines = 40
const endReserve = 2_000
const endMark = '[... end of the log]\n'

/**
 * The failure blocks of a CI log and then the end of the log, in `budget` characters plus one cut note. `node --test`
 * prints the `not ok` block of a failed test early and the summary at the end, so the end alone does not show the
 * failure. A block starts at a line with a marker and stops before the next marker line or after 40 lines. The end
 * keeps 2,000 characters, and the block space that the blocks do not use.
 */
export function failureExcerpt(log: string, budget: number): string {
  if (log.length <= budget) return log
  const lines = log.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const marked = lines.flatMap((line, index) => (failureMarker.test(line) ? [index] : []))
  const blocks = marked.map((first, index) => ({
    start: offsets[first] ?? 0,
    text: `${lines.slice(first, Math.min(first + blockLines, marked[index + 1] ?? lines.length)).join('\n')}\n`,
  }))
  const kept: string[] = []
  let used = 0
  let cut = 0
  for (const [index, block] of blocks.entries()) {
    // A block in the end of the log is in the excerpt already, and so are the blocks after it.
    if (block.start >= log.length - (budget - used - endMark.length)) break
    if (used + block.text.length > budget - endReserve) {
      const endStart = log.length - (budget - used - endMark.length)
      cut = blocks.slice(index).filter((later) => later.start < endStart).length
      break
    }
    kept.push(block.text)
    used += block.text.length
  }
  if (kept.length === 0 && cut === 0) return log.slice(-budget)
  const note = cut === 0 ? '' : `[${cut} more failure ${cut === 1 ? 'block' : 'blocks'} cut]\n`
  return `${kept.join('')}${note}${endMark}${log.slice(-(budget - used - endMark.length))}`
}
