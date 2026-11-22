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

type Repository = { name: string; owner: { login: string } }
export type Issue = { number: number; html_url?: string; pull_request?: unknown }
type IssueEvent = { event: string; label?: { name: string } | null; actor?: { login: string } | null }

const pageSize = 100
const workKinds = Object.keys(workLabels) as WorkKind[]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isInstallation = (value: unknown): value is { id: number } => isRecord(value) && Number.isInteger(value.id)
const isRepository = (value: unknown): value is Repository =>
  isRecord(value) && typeof value.name === 'string' && isRecord(value.owner) && typeof value.owner.login === 'string'
const isIssue = (value: unknown): value is Issue =>
  isRecord(value) && Number.isInteger(value.number) && (value.html_url === undefined || typeof value.html_url === 'string')
/** The issue list also gives PRs. Only a PR takes a review, and only an issue takes a development or a research run. */
const kindFits = (kind: WorkKind, issue: Issue) => (kind === 'review') === Boolean(issue.pull_request)
/** The repositories of an installation: GitHub puts the list in the repositories field of its answer. */
const repositoriesOf = (answer: unknown) => (isRecord(answer) ? answer.repositories : undefined)
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
 * an array. An answer without an array throws, and `log` gets each entry that `is` refuses.
 */
async function pages<T>(log: (line: string) => void, gh: GitHub, path: string, is: (value: unknown) => value is T, list = (answer: unknown) => answer): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const batch = list(await gh.json<unknown>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${pageSize}&page=${page}`))
    if (!Array.isArray(batch)) throw new Error(`GitHub GET ${path} gave no list`)
    for (const entry of batch) {
      if (is(entry)) all.push(entry)
      else log(`skips an entry of GET ${path} with an incorrect shape`)
    }
    if (batch.length < pageSize) return all
  }
}

/** A list that failed in a walk of the work labels. */
export type ListFailure = { list: 'installations' } | { list: 'repositories'; installation: number } | { list: 'items'; owner: string; repo: string; label: string }

/** An open issue or PR with a work label that fits the kind of the label, and the client of its installation. */
export type LabeledItem = { gh: GitHub; owner: string; repo: string; kind: WorkKind; issue: Issue }

/** The calls of a walk of the work labels of D18. */
export type LabelWalk = {
  app: GitHub
  installation: (id: number) => GitHub
  /** Gets each list entry with an incorrect shape. */
  log: (line: string) => void
  failed: (failure: ListFailure, reason: string) => void
  item: (found: LabeledItem) => Promise<void>
  /** Runs after the items of each repository. */
  repository?: (gh: GitHub, owner: string, repo: string) => Promise<void>
}

/**
 * Walks the open issues and PRs with a work label of D18 on each installation of the App. A failed list goes to `failed`,
 * and the walk continues with the next installation or label.
 */
export async function walkLabels(walk: LabelWalk): Promise<void> {
  let installations: { id: number }[]
  try {
    installations = await pages(walk.log, walk.app, '/app/installations', isInstallation)
  } catch (error) {
    walk.failed({ list: 'installations' }, reasonOf(error))
    return
  }
  for (const { id } of installations) {
    let repositories: Repository[]
    const gh = walk.installation(id)
    try {
      repositories = await pages(walk.log, gh, '/installation/repositories', isRepository, repositoriesOf)
    } catch (error) {
      walk.failed({ installation: id, list: 'repositories' }, reasonOf(error))
      continue
    }
    for (const repository of repositories) {
      const owner = repository.owner.login
      const repo = repository.name
      for (const kind of workKinds) {
        const label = workLabels[kind]
        let issues: Issue[]
        try {
          issues = await pages(walk.log, gh, `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`, isIssue)
        } catch (error) {
          walk.failed({ label, list: 'items', owner, repo }, reasonOf(error))
          continue
        }
        for (const issue of issues.filter((found) => kindFits(kind, found))) await walk.item({ gh, issue, kind, owner, repo })
      }
      await walk.repository?.(gh, owner, repo)
    }
  }
}

/**
 * The sweep of D18. It starts a run for each work item without a run, when a login in ALLOWED_USERS added its label last.
 * Then it prunes the branches of each repository. A failure is logged, and the sweep continues with the next
 * installation, repository, item or prune.
 */
export async function sweepWork(sweep: WorkSweep): Promise<void> {
  const allowed = new Set(sweep.allowed.map((login) => login.toLowerCase()))
  const log = (line: string) => sweep.log(`the work sweep ${line}`)
  await walkLabels({
    app: sweep.app,
    failed: (failure, reason) => {
      if (failure.list === 'installations') sweep.log(`the work sweep cannot list the installations: ${reason}`)
      else if (failure.list === 'repositories') sweep.log(`the work sweep cannot list the repositories of installation ${failure.installation}: ${reason}`)
      else sweep.log(`the work sweep cannot list the ${failure.label} items of ${failure.owner}/${failure.repo}: ${reason}`)
    },
    installation: sweep.installation,
    item: async ({ gh, issue: { number }, kind, owner, repo }) => {
      try {
        if (await sweep.hasRun(kind, owner, repo, number)) return
        const label = workLabels[kind]
        const events = await pages(log, gh, `/repos/${owner}/${repo}/issues/${number}/events`, requireEvent)
        // GitHub lists the events from the oldest, so the last match is the latest.
        const by = events.filter((event) => event.event === 'labeled' && event.label?.name === label).at(-1)?.actor?.login
        if (!by || !allowed.has(by.toLowerCase())) return
        await sweep.start(kind, { by, number, owner, repo })
        sweep.log(`the work sweep started a ${kind} run on ${owner}/${repo}#${number} for ${by}`)
      } catch (error) {
        sweep.log(`the work sweep failed on the ${kind} run of ${owner}/${repo}#${number}: ${reasonOf(error)}`)
      }
    },
    log,
    repository: async (gh, owner, repo) => {
      try {
        await sweep.prune(owner, repo, gh)
      } catch (error) {
        sweep.log(`the branch sweep of ${owner}/${repo} failed: ${reasonOf(error)}`)
      }
    },
  })
}
