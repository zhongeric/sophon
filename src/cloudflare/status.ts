// The status comment of a Worker run (D21). This module has no Worker runtime imports, so that the Node tests import it.
import type { Ledger } from '../core/ledger.ts'
import { commentLimit } from '../core/questions.ts'
import type { RunComments } from './comments.ts'
import { GitHubError } from './github.ts'

/** The ledger key of the status comment: { id, url }. The inbox reads it. */
export const statusCommentKey = 'status-comment'
/** The ledger key of what the run needs from the user: an Attention, or null. The inbox reads it. */
export const attentionKey = 'attention'
const bodyKey = 'status-body'
const shownKey = 'status-shown'
const stepKey = 'status-step'
const noticeKey = 'status-notice'
/** The notes of all stops of the run, so that a repeated stop posts and edits nothing (D21). */
const errorKey = 'status-error'

export type RunKind = 'development' | 'research' | 'review'

/** A result that needs the user. `url` is the PR of a ready result. */
export type ResultAttention = { kind: 'failed' | 'blocked' | 'ready'; reason: string; url?: string }
export type Attention = { kind: ResultAttention['kind'] | 'error'; reason: string; url: string }

/** The state that the status comment shows. `at` is the time of the D13 restart. `comment` is the URL of the result comment. */
export type Shown =
  | { state: 'running' }
  | { state: 'paused'; cause: string }
  | { state: 'restart'; at: number; cause: string }
  | { state: 'stopped'; cause: string }
  | { state: 'ended'; passed: boolean; summary: string; comment: string | null }

/** What names the run in its status comment. `target` is owner/repo#n. */
export type RunInfo = { run: string; kind: RunKind; by: string; target: string }

export type StatusView = RunInfo & { shown: Shown; step: string | null; notice: string | null }

/** The parts of RunComments that the status comment uses. */
export type StatusClient = Pick<RunComments, 'create' | 'edit'>

/** The most characters of a cause, a notice or a step name, so that the body stays under the 65,536 characters of GitHub. */
const lineLimit = 1_000

/** The text, cut to `limit` characters. A cut closes an open collapsed block. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  const open = head.lastIndexOf('<details>') > head.lastIndexOf('</details>')
  return `${head}${open ? '\n\n</details>' : ''}\n\n(cut)`
}

function stateLines(view: StatusView): string[] {
  const { shown } = view
  switch (shown.state) {
    case 'running':
      return [view.step ? `**State:** running. The last finished step is \`${cut(view.step, lineLimit)}\`.` : '**State:** running.']
    case 'paused':
      return [`**State:** paused: ${cut(shown.cause, lineLimit)}`]
    case 'restart':
      return [`**State:** waits for a restart at ${new Date(shown.at).toISOString()}: ${cut(shown.cause, lineLimit)}`]
    case 'stopped':
      return [
        `**State:** stopped: ${cut(shown.cause, lineLimit)}`,
        '',
        `After you fix the cause, continue the run with \`npm run remote -- resume ${view.target}\`.`,
      ]
    case 'ended': {
      const result = `**Result:** ${shown.passed ? 'passed' : 'failed'}.`
      if (shown.comment) return [`${result} See the [result comment](${shown.comment}).`]
      return [result, '', '<details><summary>Result</summary>', '', cut(shown.summary, commentLimit), '', '</details>']
    }
  }
}

/** The body of the status comment. The hidden marker identifies the comment of the run. */
export function renderStatus(view: StatusView): string {
  return [
    `<!-- agent-factory:status run=${view.run} -->`,
    `**agent-factory** ${view.kind} run \`${view.run}\` for \`${view.by}\``,
    '',
    ...stateLines(view),
    ...(view.notice ? ['', `**Budget:** ${cut(view.notice, lineLimit)}`] : []),
    '',
    'Questions come as new comments. Answer them with a `/answer` comment.',
  ].join('\n')
}

/** The status comment of one run in one alarm call. No method throws: a failed post or edit goes to `log`. */
export type RunStatus = {
  /** Posts the status comment when the ledger has none, else shows the current state. */
  open(): Promise<void>
  /** Records a finished step and shows it with the state `running`. */
  progress(step: string): void
  /** Shows the latest budget notice. */
  notice(text: string): Promise<void>
  /** Shows the state at the end of the call. It edits only when the body changes. */
  settle(shown: Shown): Promise<void>
  /**
   * Shows a stop that waits for the user. False when an earlier stop of the run had the same note, also after an admin
   * resume or a D13 restart: then the run posts and edits nothing.
   */
  stop(note: string): Promise<boolean>
  /** The URL of the status comment, or null when no post succeeded. */
  url(): string | null
}

export function runStatus(ledger: Ledger, client: StatusClient, info: RunInfo, log: (message: string, error: unknown) => void): RunStatus {
  let pending: Promise<void> = Promise.resolve()
  const shown = () => ledger.get<Shown>(shownKey) ?? { state: 'running' }
  const body = () => renderStatus({ ...info, notice: ledger.get<string>(noticeKey) ?? null, shown: shown(), step: ledger.get<string>(stepKey) ?? null })
  const post = async (text: string) => {
    try {
      const comment = await client.create(text)
      ledger.put(statusCommentKey, comment)
      ledger.put(bodyKey, text)
    } catch (error) {
      log('the post of the status comment failed', error)
    }
  }
  const write = async (text: string) => {
    const comment = ledger.get<{ id: number; url: string }>(statusCommentKey)
    // A run without a status comment, for example after a failed post or from an older ledger, posts one.
    if (!comment) return post(text)
    if (text === ledger.get<string>(bodyKey)) return
    try {
      await client.edit(comment.id, text)
      ledger.put(bodyKey, text)
    } catch (error) {
      // A user can delete the status comment. Then the run posts a new one.
      if (error instanceof GitHubError && error.status === 404) return post(text)
      log('the edit of the status comment failed', error)
    }
  }
  // The writes go one after the other, each with the body of its time, so that the last state is the last edit.
  const queue = () => {
    const text = body()
    return (pending = pending.then(() => write(text)))
  }
  return {
    open: queue,
    progress(step) {
      ledger.put(stepKey, step)
      ledger.put(shownKey, { state: 'running' })
      void queue()
    },
    notice(text) {
      ledger.put(noticeKey, text)
      return queue()
    },
    settle(next) {
      ledger.put(shownKey, next)
      return queue()
    },
    async stop(note) {
      const notes = ledger.get<string[]>(errorKey) ?? []
      if (notes.includes(note)) return false
      ledger.put(errorKey, [...notes, note])
      ledger.put(shownKey, { cause: note, state: 'stopped' } satisfies Shown)
      await queue()
      return true
    },
    url: () => ledger.get<{ id: number; url: string }>(statusCommentKey)?.url ?? null,
  }
}
