import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubError } from '../src/cloudflare/github.ts'
import { renderStatus, runStatus, statusCommentKey, type RunInfo, type StatusClient, type StatusView } from '../src/cloudflare/status.ts'
import type { Ledger } from '../src/core/ledger.ts'

function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, value) }
}

/** A client that records each post and edit. `fail` makes the next call of that kind throw. */
function fakeClient() {
  const bodies = new Map<number, string>()
  const fail: { create?: Error; edit?: Error } = {}
  const calls = { edits: [] as { id: number; body: string }[], posts: [] as string[] }
  const client: StatusClient = {
    async create(body) {
      const error = fail.create
      delete fail.create
      if (error) throw error
      calls.posts.push(body)
      const id = 100 + calls.posts.length
      bodies.set(id, body)
      return { id, url: `https://github.com/acme/app/issues/5#issuecomment-${id}` }
    },
    async edit(id, body) {
      const error = fail.edit
      delete fail.edit
      if (error) throw error
      if (!bodies.has(id)) throw new GitHubError(404, 'Not Found')
      calls.edits.push({ body, id })
      bodies.set(id, body)
    },
  }
  return { bodies, calls, client, fail }
}

const info: RunInfo = { by: 'maintainer', kind: 'development', run: 'dev-5-1', target: 'acme/app#5' }
const noLog = () => {}

test('a run that pauses, stops, waits for a restart, resumes and ends has one status comment with an edit at each change', async () => {
  const ledger = memoryLedger()
  const { bodies, calls, client } = fakeClient()
  // Each alarm call makes a new controller from the same ledger.
  const call = () => runStatus(ledger, client, info, noLog)

  let status = call()
  await status.open()
  status.progress('intake')
  await status.settle({ cause: 'waits for the answers', state: 'paused' })
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 2])

  // A poll that finds the same pause edits nothing.
  status = call()
  await status.open()
  await status.settle({ cause: 'waits for the answers', state: 'paused' })
  assert.equal(calls.edits.length, 2)

  // Each step that finishes edits the comment, so that it shows the stage.
  status = call()
  await status.open()
  status.progress('plan')
  status.progress('build')
  await status.settle({ state: 'running' })
  assert.equal(calls.edits.length, 4)
  assert.match(bodies.get(101)!, /\*\*State:\*\* running\. The last finished step is `build`\./)
  assert.equal(await status.stop('GitHub refused the call'), true)
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 5])
  assert.match(bodies.get(101)!, /\*\*State:\*\* stopped: GitHub refused the call[\s\S]*npm run remote -- resume acme\/app#5/)

  // The same error after an admin resume posts nothing and edits nothing, because the comment still shows it.
  status = call()
  await status.open()
  assert.equal(await status.stop('GitHub refused the call'), false)
  assert.equal(calls.edits.length, 5)

  status = call()
  await status.open()
  status.progress('ci')
  await status.settle({ at: Date.parse('2026-11-20T12:30:00Z'), cause: 'the job was lost', state: 'restart' })
  assert.equal(calls.edits.length, 7)
  assert.match(bodies.get(101)!, /waits for a restart at 2026-11-20T12:30:00\.000Z: the job was lost/)

  // The same error after a D13 restart posts and edits nothing.
  status = call()
  await status.open()
  assert.equal(await status.stop('GitHub refused the call'), false)
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 7])
  assert.match(bodies.get(101)!, /waits for a restart at 2026-11-20T12:30:00\.000Z: the job was lost/)

  status = call()
  await status.open()
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 7])
  status.progress('merge')
  await status.settle({ comment: null, passed: true, state: 'ended', summary: '# Development run: READY' })
  assert.equal(calls.posts.length, 1)
  assert.ok(calls.edits.length >= 4)
  assert.ok(calls.edits.every((edit) => edit.id === 101))
  assert.match(bodies.get(101)!, /\*\*Result:\*\* passed\.[\s\S]*# Development run: READY/)
  assert.equal(status.url(), 'https://github.com/acme/app/issues/5#issuecomment-101')
})

test('a stop with an earlier note posts and edits nothing, also after a stop with a different note', async () => {
  const ledger = memoryLedger()
  const { calls, client } = fakeClient()
  const call = () => runStatus(ledger, client, info, noLog)
  await call().open()
  assert.equal(await call().stop('error A'), true)
  assert.equal(await call().stop('error B'), true)
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 2])
  assert.equal(await call().stop('error A'), false)
  await call().open()
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 2])
})

test('the budget notice edits the status comment and stays in it', async () => {
  const ledger = memoryLedger()
  const { bodies, calls, client } = fakeClient()
  const status = runStatus(ledger, client, info, noLog)
  await status.open()
  await status.notice('The run reached its budget of 5 USD.')
  await status.settle({ state: 'running' })
  assert.deepEqual([calls.posts.length, calls.edits.length], [1, 1])
  assert.match(bodies.get(101)!, /\*\*Budget:\*\* The run reached its budget of 5 USD\./)
})

test('a 404 on an edit posts one new status comment and keeps its id', async () => {
  const ledger = memoryLedger()
  const { bodies, calls, client } = fakeClient()
  await runStatus(ledger, client, info, noLog).open()
  // A user deleted the status comment.
  bodies.delete(101)
  const status = runStatus(ledger, client, info, noLog)
  await status.settle({ cause: 'waits for CI', state: 'paused' })
  assert.equal(calls.posts.length, 2)
  assert.deepEqual(ledger.get(statusCommentKey), { id: 102, url: 'https://github.com/acme/app/issues/5#issuecomment-102' })
  await status.settle({ state: 'running' })
  assert.deepEqual(calls.edits.map((edit) => edit.id), [102])
})

test('a failed post or edit is logged and does not throw, and the next alarm posts the missing comment', async () => {
  const ledger = memoryLedger()
  const { calls, client, fail } = fakeClient()
  const logged: string[] = []
  const log = (message: string) => void logged.push(message)
  fail.create = new Error('GitHub is down')
  await runStatus(ledger, client, info, log).open()
  assert.equal(ledger.get(statusCommentKey), undefined)
  await runStatus(ledger, client, info, log).open()
  assert.equal(calls.posts.length, 1)
  fail.edit = new GitHubError(502, 'Bad Gateway')
  await runStatus(ledger, client, info, log).settle({ cause: 'waits for CI', state: 'paused' })
  assert.equal(calls.edits.length, 0)
  assert.deepEqual(logged, ['the post of the status comment failed', 'the edit of the status comment failed'])
  // The body stays unsent, so the next settle with the same state edits.
  await runStatus(ledger, client, info, log).settle({ cause: 'waits for CI', state: 'paused' })
  assert.equal(calls.edits.length, 1)
})

test('the status body names the run, the kind, the starter and the state, and stays under the GitHub limit', () => {
  const long = `<details><summary>Run details</summary>\n\n${'x'.repeat(200_000)}`
  const view: StatusView = { ...info, notice: 'y'.repeat(50_000), shown: { cause: 'z'.repeat(50_000), state: 'stopped' }, step: 's'.repeat(50_000) }
  const stopped = renderStatus(view)
  assert.match(stopped, /^<!-- agent-factory:status run=dev-5-1 -->\n\*\*agent-factory\*\* development run `dev-5-1` for `maintainer`/)
  assert.match(stopped, /\*\*State:\*\* stopped: z+\n\n\(cut\)/)
  assert.match(stopped, /continue the run with `npm run remote -- resume acme\/app#5`/)
  assert.ok(stopped.length < 65_536, String(stopped.length))
  const ended = renderStatus({ ...view, shown: { comment: null, passed: false, state: 'ended', summary: long } })
  assert.ok(ended.length < 65_536, String(ended.length))
  // The cut closes the open block of the summary before the block of the result closes.
  assert.match(ended, /x\n\n<\/details>\n\n\(cut\)\n\n<\/details>/)
  assert.doesNotMatch(renderStatus({ ...view, notice: null, shown: { state: 'running' }, step: 'plan' }), /stopped|resume/)
  assert.match(renderStatus({ ...view, notice: null, shown: { state: 'running' }, step: 'plan' }), /\*\*State:\*\* running\. The last finished step is `plan`\./)
})
