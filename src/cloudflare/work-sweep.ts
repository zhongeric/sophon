import { reasonOf } from '../core/prune.ts'
import type { GitHub } from './github.ts'
import { workLabels, type WorkKind } from './labels.ts'

/** An issue or a PR with a work label, and the login that added the label. */
export type WorkItem = { owner: string; repo: string; number: number; by: string }

/** The calls of the sweep. The Worker gives the real ones, and the Node tests give stubs. This module has no Worker types. */
export type WorkSweep = {
  /** The client of the App with its JWT. */
  app: GitHub
  /** The client of an installation of the App. */
  installation: (id: number) => GitHub
  /** The logins of ALLOWED_USERS. */
  allowed: string[]
  /** True when the object of this kind for the issue or PR has a run in any state. */
  hasRun: (kind: WorkKind, owner: string, repo: string, number: number) => Promise<boolean>
  start: (kind: WorkKind, item: WorkItem) => Promise<unknown>
  /** The branch sweep of a repository, with the client of its installation. */
  prune: (owner: string, repo: string, gh: GitHub) => Promise<unknown>
  log: (line: string) => void
}

export type Repository = { name: string; owner: { login: string } }
export type Issue = { number: number; pull_request?: unknown }
type IssueEvent = { event: string; label?: { name: string } | null; actor?: { login: string } | null }

const pageSize = 100
export const kinds = Object.keys(workLabels) as WorkKind[]

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isInstallation = (value: unknown): value is { id: number } => isRecord(value) && Number.isInteger(value.id)
export const isRepository = (value: unknown): value is Repository =>
  isRecord(value) && typeof value.name === 'string' && isRecord(value.owner) && typeof value.owner.login === 'string'
export const isIssue = (value: unknown): value is Issue => isRecord(value) && Number.isInteger(value.number)
/** The repositories of an installation are in the `repositories` field of the answer. */
export const repositoriesOf = (answer: unknown) => (isRecord(answer) ? answer.repositories : undefined)
const requireEvent = (value: unknown): value is IssueEvent => {
  if (
    isRecord(value) &&
    typeof value.event === 'string' &&
    (value.label == null || (isRecord(value.label) && typeof value.label.name === 'string')) &&
    (value.actor == null || (isRecord(value.actor) && typeof value.actor.login === 'string'))
  ) return true
  // An incorrect event must not let an older labeler authorize a run.
  throw new Error('GitHub issue event has an incorrect shape')
}

/**
 * All pages of a GitHub list, with only the entries that `is` accepts. `list` takes the array from an answer that is not
 * an array. An answer without an array throws, and `skip` gets the path of each entry that `is` refuses.
 */
export async function pages<T>(
  skip: (path: string) => void,
  gh: GitHub,
  path: string,
  is: (value: unknown) => value is T,
  list = (answer: unknown) => answer,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const batch = list(await gh.json<unknown>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${pageSize}&page=${page}`))
    if (!Array.isArray(batch)) throw new Error(`GitHub GET ${path} gave no list`)
    for (const entry of batch) {
      if (is(entry)) all.push(entry)
      else skip(path)
    }
    if (batch.length < pageSize) return all
  }
}

/**
 * The sweep of D18. It starts a run for each work item without a run, when a login in ALLOWED_USERS added its label last.
 * Then it prunes the branches of each repository. A failure is logged, and the sweep continues with the next
 * installation, repository, item or prune.
 */
export async function sweepWork(sweep: WorkSweep): Promise<void> {
  const allowed = new Set(sweep.allowed.map((login) => login.toLowerCase()))
  const skip = (path: string) => sweep.log(`the work sweep skips an entry of GET ${path} with an incorrect shape`)
  let installations: { id: number }[]
  try {
    installations = await pages(skip, sweep.app, '/app/installations', isInstallation)
  } catch (error) {
    sweep.log(`the work sweep cannot list the installations: ${reasonOf(error)}`)
    return
  }
  for (const { id } of installations) {
    let repositories: Repository[]
    const gh = sweep.installation(id)
    try {
      repositories = await pages(skip, gh, '/installation/repositories', isRepository, repositoriesOf)
    } catch (error) {
      sweep.log(`the work sweep cannot list the repositories of installation ${id}: ${reasonOf(error)}`)
      continue
    }
    for (const repository of repositories) {
      const owner = repository.owner.login
      const repo = repository.name
      for (const kind of kinds) {
        const label = workLabels[kind]
        let issues: Issue[]
        try {
          issues = await pages(skip, gh, `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`, isIssue)
        } catch (error) {
          sweep.log(`the work sweep cannot list the ${label} items of ${owner}/${repo}: ${reasonOf(error)}`)
          continue
        }
        // The issue list also gives PRs. Only a PR takes a review, and only an issue takes a development or a research run.
        for (const { number } of issues.filter((found) => (kind === 'review') === Boolean(found.pull_request))) {
          try {
            if (await sweep.hasRun(kind, owner, repo, number)) continue
            const events = await pages(skip, gh, `/repos/${owner}/${repo}/issues/${number}/events`, requireEvent)
            // GitHub lists the events from the oldest, so the last match is the latest.
            const by = events.filter((event) => event.event === 'labeled' && event.label?.name === label).at(-1)?.actor?.login
            if (!by || !allowed.has(by.toLowerCase())) continue
            await sweep.start(kind, { by, number, owner, repo })
            sweep.log(`the work sweep started a ${kind} run on ${owner}/${repo}#${number} for ${by}`)
          } catch (error) {
            sweep.log(`the work sweep failed on the ${kind} run of ${owner}/${repo}#${number}: ${reasonOf(error)}`)
          }
        }
      }
      try {
        await sweep.prune(owner, repo, gh)
      } catch (error) {
        sweep.log(`the branch sweep of ${owner}/${repo} failed: ${reasonOf(error)}`)
      }
    }
  }
}
