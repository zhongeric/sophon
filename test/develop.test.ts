import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PausedError } from '../src/core/questions.ts'
import { git, gitBranches, worktreePath } from '../src/node/git.ts'
import { ghPullRequests } from '../src/node/github.ts'
import { fileLedger } from '../src/node/ledger.ts'
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
  assert.match(result.report, /^- \[x\] Every task built: sub, mul, tests$/m)
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

test('develop: a run without CI blocks, and the resumed run with CI posts its new report on the PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const github = fakePulls([true])
  github.state.noCi = true
  const first = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(first.status, 'blocked', first.report)
  assert.ok(first.resume)
  assert.match(first.resume, /^No CI ran on [0-9a-f]{12}\./)
  assert.ok(first.report.includes(first.resume))

  github.state.noCi = false
  const second = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(second.status, 'ready', second.report)
  assert.equal(second.resume, null)
  assert.deepEqual(
    github.state.comments.map((comment) => comment.split('\n')[0]),
    ['# Development run: BLOCKED', '# Development run: READY'],
  )
  assert.equal(fileLedger(join(second.dir, 'state.json')).get('commented'), second.report)

  const third = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'no-ci' })
  assert.equal(third.report, second.report)
  assert.equal(github.state.comments.length, 2)
})

test('develop: a blocked builder stops the run with the reason, before any PR', { timeout: 120_000 }, async () => {
  const { repo } = developRepo()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ blockSub: true }), []), pulls: github.pulls, runId: 'blocked' })
  assert.equal(result.status, 'blocked')
  assert.match(result.report, /Task sub is blocked: sub needs a package that is not installed/)
  assert.equal(github.state.opened.length, 0)
})

test('develop: a test command writes outside the task scope, checkpoint refuses, and the builder submits a blocked log', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: `node -e "require('node:fs').writeFileSync('generated.txt', 'from tests')" {tests}` },
  })
  const turns: Turn[] = []
  const script = developScript()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), {
    runId: 'scope',
    pulls: github.pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'builder' || turn.output !== null || !turn.request.includes('Build task sub:')) return script(turn)
      return {
        cell: [
          `text(JSON.stringify(await tools.run_tests({ tests: ['test/add.test.ts'] })))`,
          `try { await tools.checkpoint({ message: 'test output' }); text('OUTSIDE COMMITTED') } catch (error) { text(String(error)) }`,
          `try { await tools.submit_build_log({ summary: 'done', changes: [], tests: [], blocked: '' }); text('DIRTY LOG ACCEPTED') } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log({ summary: 'not built', changes: [], tests: ['test/add.test.ts'], blocked: 'The test command wrote generated.txt outside the task scope' })`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'blocked', result.report)
  assert.equal(result.resume, null)
  assert.match(result.report, /Task sub is blocked: The test command wrote generated.txt outside the task scope/)
  assert.equal(github.state.opened.length, 0)
  const output = turns.filter((turn) => turn.role === 'builder').map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /checkpoint refused:.*outside the files of the task.*generated\.txt/)
  assert.match(output, /checkpoint first: uncommitted changes in generated\.txt/)
  assert.doesNotMatch(output, /OUTSIDE COMMITTED|DIRTY LOG ACCEPTED/)
  const tree = worktreePath(join(result.dir, 'branches'), 'factory/task-scope-sub')
  assert.equal(readFileSync(join(tree, 'generated.txt'), 'utf8'), 'from tests')
  await assert.rejects(git(tree, 'cat-file', '-e', 'HEAD:generated.txt'))
})

test('develop: checkpoint refuses an out-of-scope file type change from a test command', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: `node -e "const fs = require('node:fs'); fs.unlinkSync('src/math.ts'); fs.symlinkSync('sub.ts', 'src/math.ts')" {tests}` },
  })
  const original = (await git(repo, 'rev-parse', 'main')).trim()
  const turns: Turn[] = []
  const script = developScript()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), {
    runId: 'type-change',
    pulls: github.pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'builder' || turn.output !== null || !turn.request.includes('Build task sub:')) return script(turn)
      return {
        cell: [
          `await tools.Write({ file_path: '/repo/src/sub.ts', content: ${JSON.stringify(sources.sub)} })`,
          `text(JSON.stringify(await tools.run_tests({ tests: ['test/add.test.ts'] })))`,
          `try { await tools.checkpoint({ message: 'add sub' }); text('TYPE CHANGE COMMITTED') } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log({ summary: 'not built', changes: [], tests: ['test/add.test.ts'], blocked: 'The test command changed the type of src/math.ts outside the task scope' })`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /Task sub is blocked: The test command changed the type of src\/math\.ts outside the task scope/)
  assert.equal(github.state.opened.length, 0)
  const output = turns.filter((turn) => turn.role === 'builder').map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /checkpoint refused:.*outside the files of the task.*src\/math\.ts/)
  assert.doesNotMatch(output, /TYPE CHANGE COMMITTED/)
  const tree = worktreePath(join(result.dir, 'branches'), 'factory/task-type-change-sub')
  assert.equal(readlinkSync(join(tree, 'src/math.ts')), 'sub.ts')
  assert.equal((await git(tree, 'rev-parse', 'HEAD')).trim(), original)
  assert.equal(await git(tree, 'show', 'HEAD:src/math.ts'), readFileSync(join(repo, 'src/math.ts'), 'utf8'))
  await assert.rejects(git(tree, 'cat-file', '-e', 'HEAD:src/sub.ts'))
})

test('develop: a branch that exists only on origin gets a new suffix', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo()
  const original = (await git(repo, 'rev-parse', 'main')).trim()
  await git(repo, 'push', 'origin', 'main:refs/heads/factory/dev-add-sub-mul')
  await assert.rejects(git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul'))
  const github = fakePulls([true])
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'remote-branch' })
  assert.equal(result.status, 'ready', result.report)
  assert.equal(result.branch, 'factory/dev-add-sub-mul-2')
  assert.equal(github.state.opened[0]?.head, result.branch)
  assert.equal((await git(origin, 'rev-parse', 'refs/heads/factory/dev-add-sub-mul')).trim(), original)
  assert.equal((await git(origin, 'show', 'factory/dev-add-sub-mul-2:src/sub.ts')), sources.sub)
})

test('Node branches: an origin error is not an absent branch', async () => {
  const { repo } = developRepo()
  await git(repo, 'remote', 'set-url', 'origin', join(repo, 'absent.git'))
  await assert.rejects(gitBranches(repo, runsDir()).exists('factory/dev-new'))
})

test('Node branches: a merge conflict aborts and leaves a clean worktree at the original head', async () => {
  const { repo } = developRepo()
  const dir = runsDir()
  const branches = gitBranches(repo, dir)
  const target = await branches.branch('target', 'main')
  const source = await branches.branch('source', 'main')
  for (const branch of [target, source]) {
    await branch.tree.write('/src/math.ts', new TextEncoder().encode(`export const name = '${branch.name}'\n`))
    await branch.commit(`change ${branch.name}`)
  }
  const before = await target.head()
  await assert.rejects(target.merge(await source.head(), 'conflict'))
  assert.equal(await target.head(), before)
  const tree = worktreePath(dir, target.name)
  assert.equal(await git(tree, 'status', '--porcelain'), '')
  await assert.rejects(git(tree, 'rev-parse', '--verify', 'MERGE_HEAD'))
  assert.equal(readFileSync(join(tree, 'src/math.ts'), 'utf8'), "export const name = 'target'\n")
})

test('Node GitHub: failureLog returns a link when gh fails', async () => {
  const dir = runsDir()
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "log expired" >&2\nexit 1\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    const pulls = ghPullRequests(dir, 'main')
    const job = { name: 'CI', run: 12, url: 'https://ci.example/12', created: new Date().toISOString(), done: true, ok: false }
    assert.equal(await pulls.failureLog(job), 'No log: see https://ci.example/12 (gh run view: log expired)')
    assert.equal(await pulls.failureLog({ ...job, run: null }), 'No log: see https://ci.example/12')
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
})
