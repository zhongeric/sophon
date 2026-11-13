import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PausedError } from '../src/core/questions.ts'
import { developScript, developRepo, fakePulls, runDevelop, sources } from './support/develop.ts'
import { memoryChannel } from './support/fixture.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

test('develop: intake, plan, parallel builders on their own branches, draft PR, a CI fix, the review loop, a ready PR', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo()
  const turns: Turn[] = []
  const { channel, posted } = memoryChannel()
  const github = fakePulls([false, true])
  const result = await runDevelop(repo, runsDir(), { channel, dispatch: scriptedDispatch(developScript(), turns), pulls: github.pulls, runId: 'dev' })

  assert.equal(result.status, 'ready', result.report)
  assert.equal(result.branch, 'factory/dev-add-sub-mul')

  // The user confirmed the ask and the route in one batch before any plan.
  assert.deepEqual(posted.map((entry) => entry.batch), ['intake'])
  assert.deepEqual(posted[0]!.questions.map((question) => question.question.split('?')[0]), ['Is this the ask', 'Write a spec before the plan', 'How many review loop passes'])
  const first = (role: string) => turns.findIndex((turn) => turn.role === role)
  assert.ok(first('intake') < first('planner') && first('planner') < first('builder'))

  // sub and mul built in the same wave, the tests after both. Each builder could write only its own files.
  const builds = turns.filter((turn) => turn.role === 'builder' && turn.output === null).map((turn) => /Build task ([a-z]+)|Fix the CI failure/.exec(turn.request)?.[1] ?? 'ci-fix')
  assert.deepEqual(builds.slice(0, 2).sort(), ['mul', 'sub'])
  assert.deepEqual(builds.slice(2), ['tests', 'ci-fix'])
  const outputs = turns.filter((turn) => turn.role === 'builder' && turn.output).map((turn) => turn.output).join('\n')
  assert.match(outputs, /scope refused: .*EACCES/)
  assert.match(outputs, /checkpoint refused:.*test\/run.log:1: Remove test\/run.log from the change/)
  assert.doesNotMatch(outputs, /SCOPE WRITE ALLOWED|LOG COMMITTED/)

  // The PR is the run's branch, pushed without force. The first CI was red, the fix made it green.
  const show = (path: string) => execFileSync('git', ['--git-dir', origin, 'show', `factory/dev-add-sub-mul:${path}`]).toString()
  assert.deepEqual([show('src/sub.ts'), show('src/mul.ts'), show('test/ops.test.ts')], [sources.sub, sources.mul, sources.test(6)])
  assert.throws(() => execFileSync('git', ['--git-dir', origin, 'cat-file', '-e', 'factory/dev-add-sub-mul:test/run.log'], { stdio: 'pipe' }))
  assert.equal(github.state.opened.length, 1)
  assert.equal(github.state.opened[0]!.title, 'Add sub and mul')
  assert.match(github.state.opened[0]!.body, /# Ask\n\n> Add sub and mul next to add, with tests\.[\s\S]*## Done looks like/)
  assert.equal(github.state.shas.length, 2)
  assert.deepEqual(github.state.ready, [9])

  // The review loop reviewed the frozen package: the ask, the decisions and the plan.
  assert.ok(turns.some((turn) => turn.role === 'intent'))
  const review = JSON.parse(readFileSync(join(result.dir, '..', 'dev-review-1', 'state.json'), 'utf8')) as { input: { ask: string } }
  assert.match(review.input.ask, /^Add sub and mul next to add, with tests\.\n\n## Decisions of the user\n\n- Is this the ask\?[\s\S]*## Non-goals\n\n- No division/)

  assert.match(result.report, /^# Development run: READY/)
  assert.doesNotMatch(result.report, /- \[ \]/)
  assert.match(result.report, /- Pass 1: PASS, `TRIAGE path=full reason=not-docs-or-tests/)
  assert.equal(github.state.comments.length, 1)
})

test('develop: a run without intake answers pauses, and resumes without asking again or repeating the intake', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const { channel, posted, replies } = memoryChannel({ intake: null })
  const first: Turn[] = []
  await assert.rejects(
    runDevelop(repo, dir, { channel, dispatch: scriptedDispatch(developScript(), first), pulls: fakePulls().pulls, runId: 'pause' }),
    (error: unknown) => error instanceof PausedError,
  )
  assert.ok(!first.some((turn) => turn.role === 'planner'))

  replies.intake = '/answer recommended'
  const second: Turn[] = []
  const result = await runDevelop(repo, dir, { channel, dispatch: scriptedDispatch(developScript(), second), pulls: fakePulls().pulls, runId: 'pause' })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(posted.length, 1)
  assert.ok(!second.some((turn) => turn.role === 'intake'))
})

test('develop: CI that another branch ran on the same commit does not count until the push gets CI of its own', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const github = fakePulls([false, true], { stale: true })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'stale' })
  assert.equal(result.status, 'ready', result.report)
  assert.ok(Object.values(github.state.looks).every((looks) => looks >= 2), JSON.stringify(github.state.looks))
})

test('develop: a blocked builder stops the run with the reason, before any PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ blockSub: true }), []), pulls: github.pulls, runId: 'blocked' })
  assert.equal(result.status, 'blocked')
  assert.match(result.report, /Task sub is blocked: sub needs a package that is not installed/)
  assert.equal(github.state.opened.length, 0)
})
