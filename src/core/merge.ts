import type { FileSystem } from 'nanocode-ts/bash'
import type { MergeMethod } from './checks.ts'
import type { MergeRefusal, MergeResult } from './platform.ts'
import { reasonOf } from './prune.ts'

/** GitHub messages that say that the branch is not current with the base, or that a head moved during the merge. */
const staleMessage = /\b(base|head) branch was modified\b|\bout[ -]of[ -]date\b|\bnot up[ -]to[ -]date\b|\bbehind the base\b/i

/**
 * The kind of a merge refusal of GitHub, from the HTTP status when the adapter knows it and the message. GitHub answers
 * 409 when the head is not the given sha.
 */
export function mergeRefusal(status: number | undefined, message: string): MergeRefusal {
  return status === 409 || staleMessage.test(message) ? 'stale' : 'other'
}

/** True when the text has a line of a git conflict marker. */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.startsWith('<<<<<<< ') || line === '=======' || line.startsWith('>>>>>>> '))
}

/** The files of `files` that have conflict markers in `tree`. A file that is not in the tree has none: a delete resolves a conflict. */
export async function markedFiles(tree: FileSystem.FileSystem, files: string[]): Promise<string[]> {
  const marked: string[] = []
  for (const file of files) {
    const bytes = await tree.read(`/${file}`).catch(() => null)
    if (bytes && hasConflictMarkers(new TextDecoder().decode(bytes))) marked.push(file)
  }
  return marked
}

/**
 * A resumed run can find a PR that GitHub already merged before the ledger recorded the merge. `status` reads the HTTP
 * status of an error of `put`, when the adapter can. A thrown refusal of kind 'stale' is a result, other errors throw.
 */
export async function mergePull(
  put: <T>(path: string, body: Record<string, unknown>) => Promise<T>,
  get: <T>(path: string) => Promise<T>,
  path: string,
  method: MergeMethod,
  sha: string,
  status: (error: unknown) => number | undefined,
): Promise<MergeResult> {
  type Answer = { merged: boolean; sha?: string; message?: string }
  let answer: Answer
  try {
    answer = await put<Answer>(`${path}/merge`, { merge_method: method, sha })
  } catch (error) {
    const merged = await mergedAt(get, path, sha)
    if (merged) return merged
    const reason = reasonOf(error)
    if (mergeRefusal(status(error), reason) === 'stale') return { merged: false, reason, kind: 'stale' }
    throw error
  }
  if (answer.merged && answer.sha) return { merged: true, sha: answer.sha }
  const reason = answer.message ?? 'GitHub did not merge the PR'
  return (await mergedAt(get, path, sha)) ?? { merged: false, reason, kind: mergeRefusal(undefined, reason) }
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
