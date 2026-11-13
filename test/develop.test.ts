import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { github } from '../src/cloudflare/github.ts'
import { githubPulls } from '../src/cloudflare/pulls.ts'
import { developmentReview } from '../src/cloudflare/review.ts'
import { buildTools } from '../src/core/develop-steps.ts'
import { PausedError } from '../src/core/questions.ts'
import { defaultModels } from '../src/core/workflows/code-review-loop.ts'
import { checkModelOverrides, defaultDevelopModels } from '../src/core/workflows/develop.ts'
import { git, gitBranches, worktreePath } from '../src/node/git.ts'
import { ghPullRequests } from '../src/node/github.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { nodeDevelop } from '../src/node/platform.ts'
import { developInput, developScript, developRepo, fakePulls, runDevelop, sources } from './support/develop.ts'
import { credentials, memoryChannel, module } from './support/fixture.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

test('develop CLI refuses invalid --wait values before it opens a run', () => {
  for (const wait of ['0', '-1', 'two', 'Infinity']) {
    const result = spawnSync(process.execPath, ['src/node/develop.ts', '--wait', wait], { encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /stop: --wait must be a number of minutes greater than 0/)
  }
})

test('Cloudflare development reuses a review whose start was not recorded, but waits for a different ask', async () => {
  const review = { runId: 'dev-review-1', ask: 'Frozen ask and plan', full: false, head: 'head', pr: 9 }
  const request = { owner: 'acme', repo: 'app', by: 'eric' }
  const result = { pass: true, criteria: [], branch: 'factory/pr-9', final: 'fixes', report: 'PASS' }
  const ledger = fileLedger(join(runsDir(), 'state.json'))
  let starts = 0
  let ask: string | undefined
  let complete = false
  const runs = {
    async start() { starts++; return { run: 'pr-9', started: false } },
    async ask() { return ask },
    async outcome() { return complete ? result : { waiting: 'review is active' } },
  }
  for (ask of [undefined, 'An unrelated /review']) {
    await assert.rejects(developmentReview(runs, ledger, review, request), /waiting for review run pr-9 on the PR/)
    assert.equal(ledger.get('review-run:dev-review-1'), undefined)
  }
  ask = review.ask
  await assert.rejects(developmentReview(runs, ledger, review, request), /review is active/)
  assert.equal(ledger.get('review-run:dev-review-1'), 'pr-9')
  complete = true
  assert.deepEqual(await developmentReview(runs, ledger, review, request), result)
  assert.equal(starts, 3)
})

test('develop tools refuse subagents and serialize checks with checkpoints', async () => {
  const { repo } = developRepo()
  const input = developInput(repo, 'tools')
  const host = await nodeDevelop({
    repo, input, runsDir: runsDir(), credentials, module, pulls: fakePulls().pulls,
    channel: memoryChannel().channel, reviewChannel: async () => memoryChannel().channel,
    ci: { pollMs: 0, startMs: 1, waitMs: 0 }, log: () => {},
  })
  const branch = await host.branches.branch('tools', input.base)
  await branch.tree.write('/src/sub.ts', new TextEncoder().encode(sources.sub))
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  let signal = () => {}
  const started = new Promise<void>((resolve) => { signal = resolve })
  let checks = 0
  const tools = buildTools({ host, config: input.config }, {
    id: 'tools', branch, base: input.base, scope: ['src/sub.ts'], active: [], label: 'build',
    model: defaultDevelopModels.builder, review: {}, prompt: '', turn: { request: 'task', key: 'build' },
    checker: { tests: null, async checks() { checks++; signal(); await held; return [] } },
  }, input.base)
  await assert.rejects(tools.checkpoint.call({ message: 'sub' }, { subagent: 'child' }), /only the root agent calls checkpoint/)
  await assert.rejects(tools.run_checks.call({}, { subagent: 'child' }), /only the root agent calls run_checks/)
  assert.equal(checks, 0)
  assert.equal(await branch.head(), input.base)
  const checking = tools.run_checks.call({}, { subagent: null })
  const committing = tools.checkpoint.call({ message: 'sub' }, { subagent: null })
  await started
  assert.equal(checks, 1)
  assert.equal(await branch.head(), input.base)
  release()
  await Promise.all([checking, committing])
  assert.notEqual(await branch.head(), input.base)
})

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

test('develop: checkpoint refuses a protected file inside the task scope that a test command wrote', { timeout: 120_000 }, async () => {
  const { repo } = developRepo({
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    protect: ['test/fixtures/'],
    tests: {
      pattern: '\\.test\\.ts$',
      command: `node -e "const fs = require('node:fs'); fs.mkdirSync('test/fixtures', { recursive: true }); fs.writeFileSync('test/fixtures/snap.txt', 'x')" {tests}`,
    },
  })
  const turns: Turn[] = []
  const script = developScript()
  const github = fakePulls()
  const result = await runDevelop(repo, runsDir(), {
    runId: 'protected',
    pulls: github.pulls,
    dispatch: scriptedDispatch((turn) => {
      if (turn.role !== 'builder' || turn.output !== null || !turn.request.includes('Build task tests:')) return script(turn)
      return {
        cell: [
          `text(JSON.stringify(await tools.run_tests({ tests: ['test/add.test.ts'] })))`,
          `try { await tools.checkpoint({ message: 'snapshot' }); text('PROTECTED COMMITTED') } catch (error) { text(String(error)) }`,
          `await tools.submit_build_log({ summary: 'not built', changes: [], tests: [], blocked: 'The test command wrote a protected file' })`,
        ].join('\n'),
      }
    }, turns),
  })
  assert.equal(result.status, 'blocked', result.report)
  const output = turns.filter((turn) => turn.role === 'builder').map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /checkpoint refused: these files are protected.*test\/fixtures\/snap\.txt/)
  assert.doesNotMatch(output, /PROTECTED COMMITTED/)
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

test('model overrides from user input must have the shape of the defaults', () => {
  const defaults = { develop: defaultDevelopModels, review: defaultModels }
  const valid = { develop: { builder: { provider: 'claude', model: 'claude-opus-5-5', thinking: 'high' } }, review: { light: { provider: 'codex', model: 'gpt-6.1-sol' } } }
  assert.deepEqual(checkModelOverrides(valid, defaults, 'models.json'), valid)
  for (const [overrides, message] of [
    [null, /models\.json must be an object/],
    [{ develop: { builder: null } }, /models\.json\.develop\.builder must be an object/],
    [{ develop: { builder: { provider: 'other', model: '' } } }, /develop\.builder\.provider must be one of claude, codex\nmodels\.json\.develop\.builder\.model must be a model name/],
    [{ develop: { builders: { provider: 'claude', model: 'claude-opus-5-5' } } }, /models\.json\.develop: unknown key "builders"/],
    [{ review: { step1: { bugs: { provider: 'claude', model: 'claude-opus-5-5', thinking: 3 } } } }, /review\.step1\.bugs\.thinking must be a thinking level/],
  ] as const)
    assert.throws(() => checkModelOverrides(overrides, defaults, 'models.json'), message)
})

test('Cloudflare GitHub: failureLog returns a link when GitHub refuses the jobs or a log', async () => {
  const job = { name: 'CI', run: 12, url: 'https://ci.example/12', created: new Date().toISOString(), done: true, ok: false }
  const fetcher = (logStatus: number, jobsStatus = 200): typeof fetch =>
    async (input) => {
      const path = String(input)
      if (path.endsWith('/actions/runs/12/jobs?per_page=100'))
        return new Response(JSON.stringify({ jobs: [{ id: 5, name: 'test', conclusion: 'failure' }] }), { status: jobsStatus })
      if (path.endsWith('/actions/jobs/5/logs')) return new Response(logStatus === 200 ? 'line 1\nboom' : 'Not Found', { status: logStatus })
      return new Response('{}', { status: 404 })
    }
  const pulls = (logStatus: number, jobsStatus?: number) => githubPulls(github('token', 'https://api.test', fetcher(logStatus, jobsStatus)), 'acme', 'app', 'main')
  assert.equal(await pulls(200).failureLog(job), '### test\nline 1\nboom')
  assert.match(await pulls(404).failureLog(job), /^### test\nNo log: see https:\/\/ci\.example\/12 \(GitHub GET \/repos\/acme\/app\/actions\/jobs\/5\/logs answered HTTP 404: Not Found\)$/)
  assert.match(await pulls(200, 403).failureLog(job), /^No log: see https:\/\/ci\.example\/12 \(GitHub GET .* answered HTTP 403: /)
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
