import assert from 'node:assert/strict'
import { test } from 'node:test'
import { developAnnouncement } from '../src/cloudflare/announcements.ts'
import type { StatusComments } from '../src/cloudflare/comments.ts'
import { renderStatus, runStatus, stageLedger, statusKeys } from '../src/cloudflare/status.ts'
import type { Ledger } from '../src/core/ledger.ts'
import { commentLimit } from '../src/core/questions.ts'

const header = developAnnouncement('dev-5-1', 'maintainer')

const memoryLedger = (entries: Record<string, unknown> = {}) => {
  const map = new Map(Object.entries(entries))
  const ledger: Ledger = { get: <T>(key: string) => map.get(key) as T | undefined, put: (key, value) => void map.set(key, value) }
  return { ledger, map }
}

/** Comments that record each post and edit. `fail` makes the next posts or edits throw, `gone` makes edits answer 404. */
const fakeComments = () => {
  const posts: { id: number; body: string }[] = []
  const edits: { id: number; body: string }[] = []
  const faults = { post: 0, edit: 0, gone: false }
  const comments: StatusComments = {
    async post(body) {
      if (faults.post > 0) {
        faults.post--
        throw new Error('HTTP 502')
      }
      const id = posts.length + 1
      posts.push({ body, id })
      return { at: '2026-11-22T10:00:00Z', id, url: `https://github.com/acme/app/issues/5#issuecomment-${id}` }
    },
    async edit(id, body) {
      if (faults.gone) throw Object.assign(new Error('HTTP 404'), { status: 404 })
      if (faults.edit > 0) {
        faults.edit--
        throw new Error('HTTP 502')
      }
      edits.push({ body, id })
    },
    list: async () => [],
  }
  return { comments, edits, faults, posts }
}

const setup = (entries: Record<string, unknown> = {}, quiet = false) => {
  const { ledger, map } = memoryLedger(entries)
  const fake = fakeComments()
  const logs: string[] = []
  const status = runStatus({ comments: fake.comments, header, ledger, log: (line) => logs.push(line), quiet })
  return { ...fake, ledger, logs, map, status }
}

test('a run that pauses, stops, restarts and ends has one status comment with an edit for each change', async () => {
  const run = setup()
  const ledger = stageLedger(run.ledger, (stage) => run.status.stage(stage))
  await run.status.update({ state: 'running' })
  ledger.put('step:intake', { result: 1 })
  ledger.put('step:plan.1:draft', { result: 2 })
  await run.status.update({ cause: 'waiting for your answers at https://github.com/acme/app/issues/5#issuecomment-9', state: 'paused' })
  await run.status.update({ notice: 'The run spent about $10.00 of its budget of $10.00. The run continues.' })
  await run.status.error('HTTP 403', 'agent-factory stopped run `dev-5-1`: HTTP 403. After you fix the cause, continue the run with `npm run remote -- resume acme/app#5`.')
  await run.status.update({ state: 'running' })
  await run.status.update({ cause: 'lost job. The host starts the run again at 2026-11-22T11:00:00.000Z (restart 1 of 3)', restartAt: '2026-11-22T11:00:00.000Z', state: 'waiting' })
  await run.status.update({ state: 'running' })
  ledger.put('step:build', { result: 3 })
  await run.status.update({ details: '# Development run: READY', state: 'passed' })
  await run.status.settle()

  const statusPosts = run.posts.filter((post) => post.body.startsWith('- State: '))
  assert.equal(statusPosts.length, 1)
  assert.ok(run.edits.length >= 4, String(run.edits.length))
  assert.ok(run.edits.every((edit) => edit.id === 1))
  // The only other comment is the stop, which needs the user.
  assert.deepEqual(run.posts.map((post) => post.id), [1, 2])
  assert.match(run.posts[1]!.body, /^agent-factory stopped run/)
  const bodies = run.edits.map((edit) => edit.body)
  assert.ok(bodies.some((body) => body.includes('- Stage: `plan`')))
  assert.ok(bodies.some((body) => body.includes('- State: paused: waiting for your answers')))
  assert.ok(bodies.some((body) => body.includes('- State: stopped on an error: HTTP 403') && body.includes('- Details: https://github.com/acme/app/issues/5#issuecomment-2')))
  assert.ok(bodies.some((body) => body.includes('(restart 1 of 3)')))
  const last = bodies.at(-1)!
  assert.ok(last.startsWith('- State: complete with PASS\n- Stage: `build`\n- Restart: 2026-11-22T11:00:00.000Z\n- Budget: The run spent about $10.00'), last)
  assert.ok(last.includes(`continues.\n\n${header}\n\n`), last)
  assert.ok(last.endsWith('\n\n# Development run: READY'))
  assert.deepEqual(run.logs, [])
})

test('the same error note posts nothing, edits only after progress, and a different note posts and edits', async () => {
  const run = setup()
  await run.status.update({ state: 'running' })
  await run.status.error('the run died', 'stopped: the run died')
  const [posts, edits] = [run.posts.length, run.edits.length]
  await run.status.error('the run died', 'stopped: the run died')
  assert.equal(run.posts.length + run.edits.length, posts + edits)
  await run.status.update({ state: 'running' })
  await run.status.error('the run died', 'stopped: the run died')
  // After progress, the same note posts nothing, and one edit shows the stop again with the earlier link.
  assert.equal(run.posts.length, posts)
  assert.equal(run.edits.length, edits + 2)
  assert.ok(run.edits.at(-1)!.body.startsWith('- State: stopped on an error: the run died\n- Details: https://github.com/acme/app/issues/5#issuecomment-2\n'))
  await run.status.error('HTTP 403', 'stopped: HTTP 403')
  assert.equal(run.posts.length, posts + 1)
  assert.equal(run.edits.length, edits + 3)
  assert.equal(run.map.get(statusKeys.error), 'HTTP 403')
})

test('a 404 on the edit posts a new status comment and keeps its ID', async () => {
  const run = setup()
  await run.status.update({ state: 'running' })
  run.faults.gone = true
  await run.status.update({ cause: 'waiting for your answers', state: 'paused' })
  assert.equal(run.posts.length, 2)
  assert.deepEqual(run.map.get(statusKeys.comment), { id: 2, url: 'https://github.com/acme/app/issues/5#issuecomment-2' })
  run.faults.gone = false
  await run.status.update({ state: 'running' })
  assert.deepEqual(run.edits.map((edit) => edit.id), [2])
})

test('a failed first post tries again at the next change, and never posts a second status comment after the ID exists', async () => {
  const run = setup()
  run.faults.post = 1
  await run.status.update({ state: 'running' })
  assert.equal(run.posts.length, 0)
  assert.match(run.logs[0]!, /post of the status comment failed/)
  run.status.stage('intake')
  await run.status.settle()
  assert.equal(run.posts.length, 1)
  run.faults.edit = 1
  run.status.stage('plan')
  await run.status.settle()
  assert.match(run.logs[1]!, /edit of the status comment failed/)
  run.status.stage('build')
  await run.status.settle()
  assert.equal(run.posts.length, 1)
  assert.deepEqual(run.edits.map((edit) => edit.id), [1])
})

test('a run from before the status comment, with posted:announced and no ID, posts a status comment', async () => {
  const run = setup({ 'posted:announced': true })
  await run.status.update({ state: 'running' })
  assert.equal(run.posts.length, 1)
  assert.equal(run.posts[0]!.body, `- State: running\n\n${header}`)
})

test('an unchanged body makes no call, so a paused run that polls edits nothing', async () => {
  const run = setup()
  const paused = { cause: 'waiting for your answers', state: 'paused' } as const
  await run.status.update(paused)
  await run.status.update(paused)
  run.status.stage('intake')
  run.status.stage('intake')
  await run.status.settle()
  assert.equal(run.posts.length, 1)
  assert.equal(run.edits.length, 1)
})

test('a stop before the first post, or of a run that reports to its parent, puts the text into the status comment', async () => {
  const text = 'agent-factory did not start run `dev-5-1`: the preflight found failed checks.\n\nAfter you fix them, continue the run with `npm run remote -- resume acme/app#5`.'
  const first = setup()
  await first.status.error('the preflight found failed checks: x', text)
  assert.equal(first.posts.length, 1)
  assert.ok(first.posts[0]!.body.endsWith(`\n\n${text}`))
  await first.status.error('the preflight found failed checks: x', text)
  assert.equal(first.posts.length + first.edits.length, 1)

  const child = setup({}, true)
  await child.status.update({ state: 'running' })
  await child.status.error('HTTP 403', text)
  assert.equal(child.posts.length, 1)
  assert.ok(child.edits[0]!.body.endsWith(text))
})

test('the status comment is cut to the comment limit, and the cut closes an open details block', () => {
  const body = renderStatus(header, { details: `<details><summary>Report</summary>\n\n${'x'.repeat(commentLimit)}\n\n</details>`, state: 'passed' })
  assert.ok(body.length <= commentLimit)
  assert.ok(body.endsWith('\n\n</details>\n\n(cut)'))
  assert.ok(body.startsWith(`- State: complete with PASS\n\n${header}\n\n<details>`))
})
