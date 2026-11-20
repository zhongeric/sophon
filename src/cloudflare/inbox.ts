// The inbox of D21: what the Worker runs need from the user. This module has no Worker runtime imports, so that the Node tests import it.
import type { Ledger } from '../core/ledger.ts'
import { reasonOf } from '../core/prune.ts'
import type { Posted } from '../core/questions.ts'
import type { GitHub } from './github.ts'
import { workLabels, type WorkKind } from './labels.ts'
import type { State } from './prune.ts'
import { attentionKey, statusCommentKey, type Attention } from './status.ts'
import { isInstallation, isIssue, isRecord, isRepository, kinds, pages, repositoriesOf, type Issue, type Repository } from './work-sweep.ts'

export type InboxKind = 'question' | Attention['kind']
/** One thing that the latest run of an issue or a PR needs from the user. `link` is where the user acts. */
export type InboxEntry = { kind: InboxKind; run: string; reason: string; link: string }
export type InboxItem = { kind: InboxKind; repository: string; number: number; run: string; reason: string; link: string }
/** A repository or an installation that the listing could not read. */
export type InboxFailure = { repository: string; reason: string }
export type Inbox = { items: InboxItem[]; failed: InboxFailure[] }

/** The latest run of an object. `link` is the issue or the PR, for an entry without a better link. */
export type InboxRun = { run: string; state: State; note: string; link: string }

const isPosted = (value: unknown): value is Posted => isRecord(value) && typeof value.batch === 'string' && typeof value.ref === 'string'

/**
 * The inbox entries of the latest run. `posted` is the values of its posted:* ledger keys: a question batch is a Posted
 * without answers:<batch>, and the other keys hold true. A paused run without such a batch waits for CI and needs nothing.
 */
export function inboxEntries(row: InboxRun, ledger: Pick<Ledger, 'get'>, posted: unknown[]): InboxEntry[] {
  const attention = ledger.get<Attention | null>(attentionKey) ?? null
  const entry = (kind: InboxKind, reason: string, link: string): InboxEntry[] => [{ kind, link, reason, run: row.run }]
  switch (row.state) {
    case 'paused':
      return posted
        .filter(isPosted)
        .filter((batch) => !ledger.get(`answers:${batch.batch}`))
        .flatMap((batch) => entry('question', `the questions ${batch.batch} wait for your /answer comment`, batch.ref))
    case 'failed':
      return attention?.kind === 'failed' || attention?.kind === 'blocked' ? entry(attention.kind, attention.reason, attention.url) : []
    case 'error':
      return entry('error', row.note, attention?.kind === 'error' ? attention.url : (ledger.get<{ url: string }>(statusCommentKey)?.url ?? row.link))
    case 'passed':
      return attention?.kind === 'ready' ? entry('ready', attention.reason, attention.url) : []
    default:
      return []
  }
}

/** The calls of the listing. The Worker gives the real ones, and the Node tests give stubs. */
export type InboxSource = {
  /** The client of the App with its JWT. */
  app: GitHub
  /** The client of an installation of the App. */
  installation: (id: number) => GitHub
  /** The inbox entries of the object of this kind for the issue or PR. */
  entries: (kind: WorkKind, owner: string, repo: string, number: number) => Promise<InboxEntry[]>
  log: (line: string) => void
}

const labelNames = (issue: Issue): string[] =>
  Array.isArray(issue.labels)
    ? issue.labels.flatMap((label: unknown) => (typeof label === 'string' ? [label] : isRecord(label) && typeof label.name === 'string' ? [label.name] : []))
    : []

/** True for an open issue or PR with the label of `kind`. Only a PR takes a review, as in the work sweep. */
const isWork = (issue: Issue, kind: WorkKind) =>
  issue.state !== 'closed' && labelNames(issue).includes(workLabels[kind]) && (kind === 'review') === Boolean(issue.pull_request)

/**
 * The inbox of all installations of the App: the entries of each open issue and PR with a work label of D18. A failure
 * is recorded for its installation or repository, and the listing continues.
 */
export async function listInbox(source: InboxSource): Promise<Inbox> {
  const inbox: Inbox = { failed: [], items: [] }
  const skip = (path: string) => source.log(`the inbox skips an entry of GET ${path} with an incorrect shape`)
  let installations: { id: number }[]
  try {
    installations = await pages(skip, source.app, '/app/installations', isInstallation)
  } catch (error) {
    inbox.failed.push({ reason: `cannot list the installations of the GitHub App: ${reasonOf(error)}`, repository: 'all' })
    return inbox
  }
  for (const { id } of installations) {
    const gh = source.installation(id)
    let repositories: Repository[]
    try {
      repositories = await pages(skip, gh, '/installation/repositories', isRepository, repositoriesOf)
    } catch (error) {
      inbox.failed.push({ reason: `cannot list the repositories: ${reasonOf(error)}`, repository: `installation ${id}` })
      continue
    }
    for (const { name, owner } of repositories) {
      const repository = `${owner.login}/${name}`
      for (const kind of kinds) {
        const label = workLabels[kind]
        let issues: Issue[]
        try {
          issues = await pages(skip, gh, `/repos/${repository}/issues?state=open&labels=${encodeURIComponent(label)}`, isIssue)
        } catch (error) {
          inbox.failed.push({ reason: `cannot list the ${label} items: ${reasonOf(error)}`, repository })
          continue
        }
        for (const { number } of issues.filter((issue) => isWork(issue, kind))) {
          try {
            for (const found of await source.entries(kind, owner.login, name, number))
              inbox.items.push({ kind: found.kind, link: found.link, number, reason: found.reason, repository, run: found.run })
          } catch (error) {
            inbox.failed.push({ reason: `cannot read the ${kind} run of #${number}: ${reasonOf(error)}`, repository })
          }
        }
      }
    }
  }
  return inbox
}
