// The status comment of a Cloudflare run (D21). This module has no Worker imports, so that a Node test can import it.
import type { Ledger } from '../core/ledger.ts'
import { commentLimit } from '../core/questions.ts'
import type { StatusComments } from './comments.ts'

/** The ledger keys of the status comment. */
export const statusKeys = {
  /** The status comment: { id, url }. */
  comment: 'status:comment',
  /** The body that GitHub has, so that an unchanged body makes no call. */
  body: 'status:body',
  /** The note of the last error that the run gave to the user. */
  error: 'status:error',
  /** The URL of the comment with that error, or null when the status comment carries its text. */
  errorLink: 'status:error-link',
  /** The StatusView of the run. */
  view: 'status:view',
  /** The URL of the new comment with the result summary, for a result that needs the user. */
  summary: 'status:summary',
} as const

export type StatusState = 'running' | 'paused' | 'waiting' | 'error' | 'passed' | 'failed'

const stateText: Record<StatusState, string> = {
  running: 'running',
  paused: 'paused',
  waiting: 'waits for its restart',
  error: 'stopped on an error',
  passed: 'complete with PASS',
  failed: 'complete with FAIL',
}

/**
 * What the status comment shows. `stage`, `restartAt` and `notice` stay until a new value replaces them. A new state
 * removes the other fields.
 */
export type StatusView = {
  state: StatusState
  cause?: string
  /** The step that finished last, before its first '.' or ':'. */
  stage?: string
  /** The time of the last D13 restart. */
  restartAt?: string
  /** The latest budget notice. */
  notice?: string
  /** The comment that needs the user: a stop or a result. */
  link?: string
  /** Text for the user that no other comment carries: the result summary, or the cause and the resume command of a stop. */
  details?: string
}

/** The body of the status comment, at most commentLimit characters. The state comes first, so that a preview shows it. */
export function renderStatus(header: string, view: StatusView): string {
  const head = [
    `- State: ${stateText[view.state]}${view.cause ? `: ${view.cause}` : ''}`,
    ...(view.stage ? [`- Stage: \`${view.stage}\``] : []),
    ...(view.restartAt ? [`- Restart: ${view.restartAt}`] : []),
    ...(view.notice ? [`- Budget: ${view.notice}`] : []),
    ...(view.link ? [`- Details: ${view.link}`] : []),
    '',
    header,
  ].join('\n')
  const body = view.details ? `${head}\n\n${cut(view.details, commentLimit - head.length - 2)}` : head
  return body.slice(0, commentLimit)
}

/** The text cut to `room` characters. A cut closes an open details block, so that the cut note stays visible. */
function cut(text: string, room: number): string {
  if (text.length <= room) return text
  const note = '\n\n(cut)'
  const close = '\n\n</details>'
  const kept = text.slice(0, Math.max(0, room - note.length - close.length))
  const open = kept.lastIndexOf('<details>') > kept.lastIndexOf('</details>')
  return `${kept}${open ? close : ''}${note}`
}

/** The stage of a step key: the step name before its first '.' or ':'. */
const stageOf = (key: string) => key.slice('step:'.length).split(/[.:]/)[0] ?? ''

/** The ledger with a call of `onStage` after each put of a step key. */
export function stageLedger(ledger: Ledger, onStage: (stage: string) => void): Ledger {
  return {
    get: <T>(key: string) => ledger.get<T>(key),
    put(key, value) {
      ledger.put(key, value)
      if (key.startsWith('step:')) onStage(stageOf(key))
    },
  }
}

const notFound = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 404

export type RunStatus = {
  /** Sets the stage after a finished step. The edit goes into the queue. */
  stage(name: string): void
  /** Changes the view, then posts or edits the status comment. A change with a state removes the fields of the old state. */
  update(change: Partial<StatusView>): Promise<void>
  /**
   * Gives a note that needs the user: a new comment with `text`, and the status comment links to it. Without a status
   * comment, or for a run that reports to its parent run, the status comment carries `text` instead. The same note
   * as the last one posts nothing, and only shows the error again when the status comment moved on.
   */
  error(note: string, text: string): Promise<void>
  /** Waits for each queued post and edit. */
  settle(): Promise<void>
}

/**
 * The status comment of a run (D21). The run posts it when the ledger has no ID, also for a run from before D21,
 * and else edits it. Only a 404 on an edit, for example after a user deleted the comment, posts a new one. A failed
 * call goes to `log` and never throws: the next change tries again. With `quiet`, the run reports to its parent run,
 * so it posts no comment other than its status comment.
 */
export function runStatus(options: {
  ledger: Ledger
  comments: StatusComments
  header: string
  quiet: boolean
  log: (line: string, error: unknown) => void
}): RunStatus {
  const { ledger, comments } = options
  let queue = Promise.resolve()
  // A failed ledger write must not stop the edits that come after it.
  const enqueue = (work: () => Promise<void>): Promise<void> => (queue = queue.then(work).catch((error: unknown) => options.log('the status comment failed', error)))
  const view = () => ledger.get<StatusView>(statusKeys.view) ?? { state: 'running' }
  const set = (change: Partial<StatusView>) => {
    const current = view()
    const kept = change.state === undefined ? current : { notice: current.notice, restartAt: current.restartAt, stage: current.stage, state: current.state }
    ledger.put(statusKeys.view, { ...kept, ...change })
  }
  const post = async (body: string) => {
    const { id, url } = await comments.post(body)
    ledger.put(statusKeys.comment, { id, url })
  }
  /** Gives the view to GitHub. True when GitHub has the body. */
  const sync = async (): Promise<boolean> => {
    const body = renderStatus(options.header, view())
    const posted = ledger.get<{ id: number; url: string }>(statusKeys.comment)
    if (posted && ledger.get(statusKeys.body) === body) return true
    try {
      if (!posted) await post(body)
      else
        try {
          await comments.edit(posted.id, body)
        } catch (error) {
          if (!notFound(error)) throw error
          await post(body)
        }
      ledger.put(statusKeys.body, body)
      return true
    } catch (error) {
      options.log(`the ${posted ? 'edit' : 'post'} of the status comment failed`, error)
      return false
    }
  }
  return {
    stage(name) {
      void enqueue(async () => {
        set({ stage: name, state: 'running' })
        await sync()
      })
    },
    update: (change) =>
      enqueue(async () => {
        set(change)
        await sync()
      }),
    error: (note, text) =>
      enqueue(async () => {
        if (ledger.get(statusKeys.error) === note) {
          const current = view()
          if (current.state === 'error' && current.cause === note) return
          const link = ledger.get<string | null>(statusKeys.errorLink)
          set(link ? { cause: note, link, state: 'error' } : { cause: note, details: text, state: 'error' })
          await sync()
          return
        }
        let link: string | undefined
        if (!options.quiet && ledger.get(statusKeys.comment))
          try {
            link = (await comments.post(text)).url
          } catch (error) {
            options.log('the post of the error comment failed', error)
          }
        set(link ? { cause: note, link, state: 'error' } : { cause: note, details: text, state: 'error' })
        // The note counts as given when a comment carries it. Else the same note tries again.
        if ((await sync()) || link) {
          ledger.put(statusKeys.errorLink, link ?? null)
          ledger.put(statusKeys.error, note)
        }
      }),
    settle: () => enqueue(async () => {}),
  }
}
