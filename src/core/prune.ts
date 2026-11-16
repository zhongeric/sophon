/** The state of a pull request on GitHub. */
export type PullState = 'open' | 'merged' | 'closed'

/** The run that owns a branch. `finished` is false for a run in state queued, running, paused or error, because it can go on. */
export type BranchRun = { kind: 'review' | 'develop' | 'task'; finished: boolean; ship: boolean }

/**
 * What the host knows about one branch. `run` is null when no known run owns the branch. `pr` is the PR whose head the
 * branch is, or for a review fix branch the PR that the run reviews. `applied` is true when the head is in the PR branch
 * or in a development branch. Only an unknown run reads `inDefault`.
 */
export type BranchFacts = { name: string; run: BranchRun | null; pr: PullState | null; applied: boolean; inDefault: boolean }

export type Verdict = { rule: 'merged' | 'applied' | 'stranded' | 'kept'; reason: string }

export type PruneResult = {
  deleted: { name: string; rule: 'merged' | 'applied' | 'stranded' }[]
  kept: { name: string; reason: string }[]
  failed: { name: string; reason: string }[]
}

const prefix = 'factory/'
const reasonChars = 300

const kept = (reason: string): Verdict => ({ rule: 'kept', reason })

/** One rule set for the end of a run, the webhook and the sweep. The order of the rules is the order of the checks. */
export function classifyBranch(facts: BranchFacts): Verdict {
  const { run, pr } = facts
  if (!facts.name.startsWith(prefix)) return kept('outside factory/')
  if (run && !run.finished) return kept('run not finished')
  if (facts.applied) return { rule: 'applied', reason: 'the head is in the PR branch or in a development branch' }
  if (!run) {
    // A branch that no known run owns goes only when nothing can still need it.
    if (pr !== 'open' && facts.inDefault) return { rule: 'merged', reason: 'the head is in the default branch' }
    return kept('unknown run')
  }
  const unapplied = run.kind === 'review' && !run.ship
  if (pr === 'open') return kept(unapplied ? 'unapplied review fixes' : 'open PR')
  if (pr === 'merged') return { rule: 'merged', reason: 'the PR merged' }
  if (pr === 'closed') return { rule: 'stranded', reason: 'the PR closed without a merge' }
  // A local --base review run has no PR: the user applies its fixes from factory/<run> (decision 5 of the spec).
  if (run.kind === 'review') return kept('unapplied review fixes')
  return { rule: 'stranded', reason: 'the run finished without a PR' }
}

/** Deletes each branch that is not kept. A failed delete goes to `failed` and never stops the other deletes or the run. */
export async function pruneBranches(facts: BranchFacts[], remove: (name: string) => Promise<void>): Promise<PruneResult> {
  const result: PruneResult = { deleted: [], kept: [], failed: [] }
  for (const branch of facts) {
    const verdict = classifyBranch(branch)
    if (verdict.rule === 'kept') {
      result.kept.push({ name: branch.name, reason: verdict.reason })
      continue
    }
    try {
      await remove(branch.name)
      result.deleted.push({ name: branch.name, rule: verdict.rule })
    } catch (error) {
      result.failed.push({ name: branch.name, reason: reasonOf(error) })
    }
  }
  return result
}

/** The Branches section of a report, or no lines when the prune deleted nothing and nothing failed. */
export function branchesSection(result: PruneResult): string[] {
  if (result.deleted.length === 0 && result.failed.length === 0) return []
  return [
    '## Branches',
    '',
    ...result.deleted.map((branch) => `- deleted ${branch.name} (${branch.rule})`),
    ...result.failed.map((branch) => `- not deleted ${branch.name}: ${branch.reason}`),
    '',
  ]
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, reasonChars)
