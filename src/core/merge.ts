import type { MergeMethod } from './checks.ts'
import type { MergeResult } from './platform.ts'

/** A resumed run can find a PR that GitHub merged before the ledger recorded the merge. */
export async function mergePull(
  put: <T>(path: string, body: Record<string, unknown>) => Promise<T>,
  get: <T>(path: string) => Promise<T>,
  path: string,
  method: MergeMethod,
  sha: string,
): Promise<MergeResult> {
  type Answer = { merged: boolean; sha?: string; message?: string }
  let answer: Answer
  try {
    answer = await put<Answer>(`${path}/merge`, { merge_method: method, sha })
  } catch (error) {
    const merged = await mergedAt(get, path, sha)
    if (merged) return merged
    throw error
  }
  if (answer.merged && answer.sha) return { merged: true, sha: answer.sha }
  return (await mergedAt(get, path, sha)) ?? { merged: false, reason: answer.message ?? 'GitHub did not merge the PR' }
}

/**
 * The merge of a PR that GitHub already merged at the head `sha`, or undefined. A resumed run can call the merge again
 * after a merge that its ledger did not record. GitHub refuses that call, so the host reads the PR before it records a
 * refusal. `path` is the API path of the PR. When the read fails, the refusal stays.
 */
async function mergedAt(get: <T>(path: string) => Promise<T>, path: string, sha: string): Promise<MergeResult | undefined> {
  try {
    const pull = await get<{ merged: boolean; merge_commit_sha: string | null; head: { sha: string } }>(path)
    if (pull.merged && pull.merge_commit_sha && pull.head.sha === sha) return { merged: true, sha: pull.merge_commit_sha }
  } catch {
    // The read is only a check: the error of the merge call is the reason.
  }
  return undefined
}
