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
import { developInput, developScript, developRepo, fakePulls, mergeCommit, runDevelop, sources } from './support/develop.ts'
import { memoryChannel } from './support/fixture.ts'
import { probeNetwork, scriptedDispatch, webSearch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

test('develop: intake, plan, parallel builders on their own branches, draft PR, a CI fix, the review loop, a ready PR', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo()
  const turns: Turn[] = []
  const { channel, posted } = memoryChannel()
  const github = fakePulls([false, true])
  const result = await runDevelop(repo, runsDir(), { channel, dispatch: scriptedDispatch(probeNetwork(developScript(), 'builder'), turns), pulls: github.pulls, runId: 'dev' })

  assert.equal(result.status, 'ready', result.report)
  assert.equal(result.branch, 'factory/dev-add-sub-mul')

  // The user confirmed the ask and the route in one batch before any plan.
  assert.deepEqual(posted.map((entry) => entry.batch), ['intake'])
  assert.deepEqual(posted[0]!.questions.map((question) => question.question.split('?')[0]), ['Is this the ask', 'Write a spec before the plan', 'How many review loop passes'])
  const first = (role: string) => turns.findIndex((turn) => turn.role === role)
  assert.ok(first('intake') < first('planner') && first('planner') < first('builder'))
  // The development and review roles have no egress: the cell fetch and the shell of a builder fail, and no model request
  // has the web search tool.
  const probes = turns.filter((turn) => turn.role === 'builder' && turn.output).map((turn) => turn.output).join('\n')
  assert.match(probes, /cell fetch: .*network access is off/)
  assert.match(probes, /shell fetch: .*network access is off/)
  assert.ok(!turns.some((turn) => webSearch.test(turn.request)))

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

  // Without the merge permission, the host does not merge and does not delete the branch.
  assert.match(result.report, /^Ready for your review\. You merge\.$/m)
  assert.deepEqual(github.state.merges, [])
  assert.equal(result.merge, null)
  assert.doesNotMatch(github.state.opened[0]!.body, /Closes/)
  await git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul')
})

test('develop: with the merge permission, the host merges the ready PR at the checked head and deletes only the remote branch', { timeout: 120_000 }, async () => {
  const { repo, origin } = developRepo(undefined, { merge: 'squash' })
  const dir = runsDir()
  const github = fakePulls([false, true])
  const input = await developInput(repo, 'merged', { issue: 12 })
  const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: github.pulls, runId: 'merged' })

  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(github.state.ready, [9])
  const head = (await git(repo, 'rev-parse', 'refs/heads/factory/dev-add-sub-mul')).trim()
  assert.equal(github.state.shas.at(-1), head)
  assert.deepEqual(github.state.merges, [{ pr: 9, method: 'squash', sha: head }])
  assert.match(github.state.opened[0]!.body, /opened this draft PR\. .*\n\nCloses #12\n\n# Ask\n/)
  assert.deepEqual(result.merge, { method: 'squash', sha: mergeCommit })
  assert.match(result.report, new RegExp(`^Merged by the host \\(squash\\): ${mergeCommit}\\.$`, 'm'))
  assert.equal(github.state.comments.length, 1)
  assert.ok(github.state.comments[0]!.includes(`Merged by the host (squash): ${mergeCommit}.`))
  assert.deepEqual(fileLedger(join(result.dir, 'state.json')).get('result'), { status: 'ready', pr: result.pr, branch: result.branch, merge: result.merge })
  // Only the remote branch is gone. The local branch stays.
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul'))
  await git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/factory/dev-add-sub-mul')

  // A resumed run does not merge again and posts no new comment.
  const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), input, pulls: github.pulls, runId: 'merged' })
  assert.equal(again.report, result.report)
  assert.deepEqual(again.merge, result.merge)
  assert.equal(github.state.merges.length, 1)
  assert.equal(github.state.comments.length, 1)
})

test('develop: a refused merge and a merge error leave the PR ready with the reason, and a resumed run does not merge again', { timeout: 240_000 }, async () => {
  const cases = [
    { reason: 'Head branch was modified', merge: () => ({ merged: false as const, reason: 'Head branch was modified' }) },
    {
      reason: 'socket hang up',
      merge: () => {
        throw new Error('socket hang up')
      },
    },
  ]
  for (const { reason, merge } of cases) {
    const { repo, origin } = developRepo(undefined, { merge: 'rebase' })
    const dir = runsDir()
    const github = fakePulls([false, true], { merge })
    const result = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'refused' })
    assert.equal(result.status, 'ready', result.report)
    assert.deepEqual(github.state.ready, [9])
    assert.equal(github.state.merges.length, 1)
    assert.equal(github.state.merges[0]!.method, 'rebase')
    assert.equal(result.merge, null)
    assert.match(result.report, new RegExp(`^Not merged: ${reason}\\. The PR stays ready for your review\\. You merge\\.$`, 'm'))
    await git(origin, 'rev-parse', '--verify', 'refs/heads/factory/dev-add-sub-mul')

    const again = await runDevelop(repo, dir, { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'refused' })
    assert.equal(again.report, result.report)
    assert.equal(github.state.merges.length, 1, reason)
    assert.equal(github.state.comments.length, 1, reason)
  }
})

test('develop: a merge whose branch delete fails keeps the run merged and notes the branch', { timeout: 120_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'merge' })
  const github = fakePulls([false, true], {
    merge: () => {
      // origin goes away after the merge, so the branch delete fails.
      execFileSync('git', ['remote', 'set-url', 'origin', join(repo, 'absent.git')], { cwd: repo })
      return { merged: true, sha: mergeCommit }
    },
  })
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript(), []), pulls: github.pulls, runId: 'undeleted' })
  assert.equal(result.status, 'ready', result.report)
  assert.deepEqual(result.merge, { method: 'merge', sha: mergeCommit })
  assert.match(result.report, new RegExp(`^Merged by the host \\(merge\\): ${mergeCommit}\\. The host did not delete the branch factory/dev-add-sub-mul: .+\\.$`, 'm'))
})

test('develop: a run that fails a criterion with the merge permission does not merge', { timeout: 120_000 }, async () => {
  const { repo } = developRepo(undefined, { merge: 'squash' })
  // CI is green on the build, the review loop fixes the test, and CI is red on the final head.
  const github = fakePulls([true, false])
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ reviewFix: true }), []), pulls: github.pulls, runId: 'failed' })
  assert.equal(result.status, 'failed', result.report)
  assert.match(result.report, /^- \[ \] CI green on the head/m)
  assert.deepEqual(github.state.merges, [])
  assert.deepEqual(github.state.ready, [])
  assert.equal(result.merge, null)
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
  // The first commit with CI is red and the fix makes it green, as in the first test: the review then passes.
  const github = fakePulls([false, true])
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
  const { repo } = developRepo(undefined, { merge: 'squash' })
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), { dispatch: scriptedDispatch(developScript({ blockSub: true }), []), pulls: github.pulls, runId: 'blocked' })
  assert.equal(result.status, 'blocked')
  assert.match(result.report, /Task sub is blocked: sub needs a package that is not installed/)
  assert.equal(github.state.opened.length, 0)
  assert.deepEqual(github.state.merges, [])
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
  const github = fakePulls([false, true])
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

test('Node GitHub: merge runs gh pr merge at the head, and only a merged PR with a merge commit is a merge', async () => {
  const dir = runsDir()
  const calls = join(dir, 'calls')
  const gh = (view: string) =>
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "$*" >> "${calls}"\nif [ "$2" = view ]; then printf '%s' '${view}'; fi\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path ?? ''}`
  try {
    const pulls = ghPullRequests(dir, 'main')
    gh('{"state":"MERGED","mergeCommit":{"oid":"abc123"}}')
    assert.deepEqual(await pulls.merge(9, { method: 'squash', sha: 'f00d' }), { merged: true, sha: 'abc123' })
    assert.deepEqual(readFileSync(calls, 'utf8').split('\n').filter(Boolean), ['pr merge 9 --squash --match-head-commit f00d', 'pr view 9 --json state,mergeCommit'])

    gh('{"state":"OPEN","mergeCommit":null}')
    assert.deepEqual(await pulls.merge(9, { method: 'rebase', sha: 'f00d' }), { merged: false, reason: 'the PR is OPEN after gh pr merge' })

    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "Pull request is not mergeable:\\nthe merge commit cannot be cleanly created" >&2\nexit 1\n', { mode: 0o755 })
    assert.deepEqual(await pulls.merge(9, { method: 'merge', sha: 'f00d' }), {
      merged: false,
      reason: 'gh pr merge: Pull request is not mergeable: the merge commit cannot be cleanly created',
    })
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
  }
})
