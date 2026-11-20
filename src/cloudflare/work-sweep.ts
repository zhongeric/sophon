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
  /** The branch sweep of a repository. */
  prune: (owner: string, repo: string) => Promise<unknown>
  log: (line: string) => void
}

type Repository = { name: string; owner: { login: string } }
type Issue = { number: number; pull_request?: unknown }
type IssueEvent = { event: string; label?: { name: string }; actor?: { login: string } | null }

const pageSize = 100
const kinds = Object.keys(workLabels) as WorkKind[]

/** All pages of a GitHub list. `items` takes the list from an answer that is not an array. */
async function pages<T>(gh: GitHub, path: string, items: (answer: unknown) => T[] = (answer) => answer as T[]): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; ; page++) {
    const batch = items(await gh.json<unknown>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${pageSize}&page=${page}`))
    all.push(...batch)
    if (batch.length < pageSize) return all
  }
}

/**
 * The message when GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set, or null when both are set. The sweep finds the
 * repositories through the installations of the App, so it needs both.
 */
export function missingAppSecrets(secrets: { GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string }): string | null {
  const missing = (['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'] as const).filter((name) => !secrets[name])
  if (missing.length === 0) return null
  return `the work sweep does nothing: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`
}

/**
 * The sweep of D18. It starts a run for each open issue or PR with a work label whose object has no run, when a login
 * in ALLOWED_USERS added the label last. Then it prunes the branches of each repository. A failure is logged, and the
 * sweep continues with the next installation, repository, item or prune.
 */
export async function sweepWork(sweep: WorkSweep): Promise<void> {
  const allowed = new Set(sweep.allowed.map((login) => login.toLowerCase()))
  let installations: { id: number }[]
  try {
    installations = await pages(sweep.app, '/app/installations')
  } catch (error) {
    sweep.log(`the work sweep cannot list the installations: ${reasonOf(error)}`)
    return
  }
  for (const { id } of installations) {
    let repositories: Repository[]
    const gh = sweep.installation(id)
    try {
      repositories = await pages(gh, '/installation/repositories', (answer) => (answer as { repositories: Repository[] }).repositories)
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
          issues = await pages(gh, `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`)
        } catch (error) {
          sweep.log(`the work sweep cannot list the ${label} items of ${owner}/${repo}: ${reasonOf(error)}`)
          continue
        }
        // The issue list also gives PRs. Only a PR takes a review, and only an issue takes a development or a research run.
        for (const { number } of issues.filter((found) => (kind === 'review') === Boolean(found.pull_request))) {
          try {
            if (await sweep.hasRun(kind, owner, repo, number)) continue
            const events = await pages<IssueEvent>(gh, `/repos/${owner}/${repo}/issues/${number}/events`)
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
        await sweep.prune(owner, repo)
      } catch (error) {
        sweep.log(`the branch sweep of ${owner}/${repo} failed: ${reasonOf(error)}`)
      }
    }
  }
}
