// The inbox of D21: the items on all repositories of the App that wait for the user. This module has no Worker types, so
// that the Node tests import it.
import type { Ledger } from '../core/ledger.ts'
import { reasonOf } from '../core/prune.ts'
import type { GitHub } from './github.ts'
import { workLabels, type WorkKind } from './labels.ts'
import type { State } from './prune.ts'
import { statusKeys, type StatusView } from './status.ts'
import { isInstallation, isIssue, isRecord, isRepository, kindFits, pages, repositoriesOf, workKinds, type Issue, type Repository } from './work-sweep.ts'

export type InboxKind = 'question' | 'failed' | 'blocked' | 'error' | 'ready'

/** An item that waits for the user. `repository` is owner/repo. */
export type InboxItem = { kind: InboxKind; repository: string; number: number; cause: string; link: string }

/** An item of the latest run of one object. Without a link, the inbox links the issue or PR. */
export type InboxEntry = { kind: InboxKind; cause: string; link: string | null }

/** An installation, a repository or an item that the inbox cannot read. */
export type InboxSkip = { what: string; reason: string }

export type Inbox = { items: InboxItem[]; skipped: InboxSkip[] }

/** The calls of the inbox. The Worker gives the real ones, and the Node tests give stubs. */
export type InboxSource = {
  /** The client of the App with its JWT. */
  app: GitHub
  /** The client of an installation of the App. */
  installation: (id: number) => GitHub
  /** The entries of the latest run of this kind on the issue or PR. */
  entries: (kind: WorkKind, owner: string, repo: string, number: number) => Promise<InboxEntry[]>
  log: (line: string) => void
}

const active: State[] = ['queued', 'running', 'paused']

/**
 * The entries of one run: its open `user` question batches while it works, its stop, its FAIL or blocked result, and a
 * ready PR that the host did not merge. `batches` are the names of the posted:<batch> keys of its ledger.
 */
export function runEntries(run: { state: State; note: string }, ledger: Ledger, batches: string[]): InboxEntry[] {
  const status = ledger.get<{ url: string }>(statusKeys.comment)?.url ?? null
  const stored: unknown = ledger.get('result')
  const result = isRecord(stored) ? stored : {}
  const outcome = typeof result.status === 'string' ? result.status : null
  if (active.includes(run.state))
    return batches.flatMap((batch) => {
      // The once() keys of the run, for example posted:label, also start with posted: but have no ref.
      const posted: unknown = ledger.get(`posted:${batch}`)
      if (!isRecord(posted) || typeof posted.ref !== 'string' || ledger.get(`answers:${batch}`) !== undefined) return []
      return [{ cause: `the questions ${batch} wait for your /answer`, kind: 'question' as const, link: posted.ref }]
    })
  if (run.state === 'error') return [{ cause: run.note || 'the run stopped on an error', kind: 'error', link: ledger.get<StatusView>(statusKeys.view)?.link ?? status }]
  if (run.state === 'failed')
    return [{ cause: `the run ended with ${outcome ?? 'FAIL'}`, kind: outcome === 'blocked' ? 'blocked' : 'failed', link: ledger.get<string>(statusKeys.summary) ?? status }]
  // A research result has no merge field: the user merges each dossier PR.
  const pr = result.pr
  if (outcome === 'ready' && isRecord(pr) && typeof pr.url === 'string' && result.merge == null)
    return [{ cause: `PR #${String(pr.number)} is ready and waits for your merge`, kind: 'ready', link: pr.url }]
  return []
}

/**
 * Lists the items that wait for the user, for each open issue and PR with a work label of D18 on each installation of
 * the App. An installation, a repository or an item that the inbox cannot read goes to `skipped`, and the list continues.
 */
export async function listInbox(source: InboxSource): Promise<Inbox> {
  const log = (line: string) => source.log(`the inbox ${line}`)
  const items: InboxItem[] = []
  const skipped: InboxSkip[] = []
  let installations: { id: number }[]
  try {
    installations = await pages(log, source.app, '/app/installations', isInstallation)
  } catch (error) {
    return { items, skipped: [{ reason: reasonOf(error), what: 'the installations' }] }
  }
  for (const { id } of installations) {
    const gh = source.installation(id)
    let repositories: Repository[]
    try {
      repositories = await pages(log, gh, '/installation/repositories', isRepository, repositoriesOf)
    } catch (error) {
      skipped.push({ reason: reasonOf(error), what: `installation ${id}` })
      continue
    }
    for (const repository of repositories) {
      const owner = repository.owner.login
      const repo = repository.name
      for (const kind of workKinds) {
        const label = workLabels[kind]
        let issues: Issue[]
        try {
          issues = await pages(log, gh, `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`, isIssue)
        } catch (error) {
          skipped.push({ reason: `the list of the ${label} items failed: ${reasonOf(error)}`, what: `${owner}/${repo}` })
          continue
        }
        for (const issue of issues.filter((found) => kindFits(kind, found))) {
          // The guard of the sweep does not check html_url, so the link of the issue or PR is checked here.
          const fields: unknown = issue
          const page = isRecord(fields) && typeof fields.html_url === 'string' ? fields.html_url : ''
          try {
            for (const entry of await source.entries(kind, owner, repo, issue.number))
              items.push({ cause: entry.cause, kind: entry.kind, link: entry.link ?? page, number: issue.number, repository: `${owner}/${repo}` })
          } catch (error) {
            skipped.push({ reason: `the ${kind} run cannot be read: ${reasonOf(error)}`, what: `${owner}/${repo}#${issue.number}` })
          }
        }
      }
    }
  }
  return { items, skipped }
}
