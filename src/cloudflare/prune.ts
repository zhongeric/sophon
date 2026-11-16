import { pruneBranches, type BranchFacts, type PruneResult, type PullState } from '../core/prune.ts'
import { deleteRemoteBranch } from './branches.ts'
import type { GitHub } from './github.ts'
import { encodePath } from './trees.ts'

/** The state of a run. It lives here and not in runs.ts, so that the Node tests of the sweep typecheck without Worker types. */
export type State = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error'

/** The state and the ship flag of a run, from its PullRequestRuns or DevelopmentRuns object, or null for no such run. */
export type RunLookup = (kind: 'review' | 'develop', number: number, run: string) => Promise<{ state: State; ship: boolean } | null>

type Ref = { ref: string; object: { sha: string } }
/** A PR view or an item of the PR list. Only the view has `merged`, so the list gives the merge with `merged_at`. */
type Pull = { state: string; merged?: boolean; merged_at?: string | null; body?: string | null; head: { sha: string } }

const pageSize = 100
const reasonChars = 300

const stateOf = (pull: Pull): PullState => (pull.merged || pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open')
/** Queued, running, paused and error runs can go on, so only passed and failed runs are finished. */
const finished = (state: State) => state === 'passed' || state === 'failed'
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, reasonChars)

/**
 * Prunes the factory/* branches on GitHub with the rules of src/core/prune.ts. `only` limits the sweep, for example to
 * the branches of one closed PR. When GitHub fails for one branch, the sweep keeps that branch with the reason and goes on.
 */
export async function sweepBranches(options: { gh: GitHub; owner: string; repo: string; lookup: RunLookup; only?: (name: string) => boolean }): Promise<PruneResult> {
  const { gh, owner, lookup } = options
  const api = `/repos/${owner}/${options.repo}`
  const refs: Ref[] = []
  for (let page = 1; ; page++) {
    const batch = await gh.json<Ref[]>('GET', `${api}/git/matching-refs/heads/factory/?per_page=${pageSize}&page=${page}`)
    refs.push(...batch)
    if (batch.length < pageSize) break
  }
  /** True when `sha` is in `base`: the merge base of the two is `sha`. */
  const contains = async (base: string, sha: string) =>
    (await gh.json<{ merge_base_commit: { sha: string } }>('GET', `${api}/compare/${base}...${sha}`)).merge_base_commit.sha === sha
  let defaultBranch: Promise<string> | undefined
  const inDefault = async (sha: string) => {
    defaultBranch ??= gh.json<{ default_branch: string }>('GET', api).then((view) => view.default_branch)
    return contains(encodePath(await defaultBranch), sha)
  }

  const factsOf = async (name: string, sha: string): Promise<BranchFacts> => {
    const unknown = async (pr: PullState | null): Promise<BranchFacts> => ({ applied: false, inDefault: pr !== 'open' && (await inDefault(sha)), name, pr, run: null })
    // The listing gives only factory/ names. A name outside factory/ is kept without a GitHub call.
    if (!name.startsWith('factory/')) return { applied: false, inDefault: false, name, pr: null, run: null }
    const review = /^factory\/(pr-(\d+)-.+)$/.exec(name)
    if (review) {
      const number = Number(review[2])
      const pull = await gh.json<Pull>('GET', `${api}/pulls/${number}`)
      const found = await lookup('review', number, review[1]!)
      if (!found) return unknown(stateOf(pull))
      const run = { finished: finished(found.state), kind: 'review' as const, ship: found.ship }
      return { applied: await contains(pull.head.sha, sha), inDefault: false, name, pr: stateOf(pull), run }
    }
    const pull = (await gh.json<Pull[]>('GET', `${api}/pulls?head=${encodeURIComponent(`${owner}:${name}`)}&state=all`))[0]
    if (!pull) return unknown(null)
    // The development run writes its ID in the body of its PR. The ID dev-<issue>-<stamp> names the object of the issue.
    const id = /agent-factory run `(dev-(\d+)-[^`]+)`/.exec(pull.body ?? '')
    const found = name.startsWith('factory/dev-') && id ? await lookup('develop', Number(id[2]), id[1]!) : null
    if (!found) return unknown(stateOf(pull))
    return { applied: false, inDefault: false, name, pr: stateOf(pull), run: { finished: finished(found.state), kind: 'develop', ship: found.ship } }
  }

  const facts: BranchFacts[] = []
  const unread: PruneResult['kept'] = []
  for (const ref of refs) {
    const name = ref.ref.replace(/^refs\/heads\//, '')
    if (options.only && !options.only(name)) continue
    try {
      facts.push(await factsOf(name, ref.object.sha))
    } catch (error) {
      unread.push({ name, reason: `facts not read: ${reasonOf(error)}` })
    }
  }
  const result = await pruneBranches(facts, (name) => deleteRemoteBranch(gh, api, name))
  return { ...result, kept: [...result.kept, ...unread] }
}
