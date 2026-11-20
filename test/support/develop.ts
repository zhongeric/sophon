import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Contracts } from 'nanocode-ts'
import type { CiJob } from '../../src/core/ci.ts'
import type { MergeMethod } from '../../src/core/checks.ts'
import type { MergeResult, PullRequests, Signing } from '../../src/core/platform.ts'
import { PausedError, type Channel } from '../../src/core/questions.ts'
import { zeroTokens, type Prices } from '../../src/core/usage.ts'
import { defaultModels, type Criterion } from '../../src/core/workflows/code-review-loop.ts'
import { defaultDevelopModels, develop, type DevelopDeps, type DevelopInput, type ReviewRequest } from '../../src/core/workflows/develop.ts'
import { loadRepoConfig, nodeDevelop } from '../../src/node/platform.ts'
import { credentials, memoryChannel, module, withoutKey } from './fixture.ts'
import type { Script } from './scripted-model.ts'

/**
 * A repository with add() on main, and a bare origin that the run pushes to. `config` replaces the checks config.
 * `merge` adds the merge permission to the config.
 */
export function developRepo(config?: Record<string, unknown>, options: { merge?: MergeMethod } = {}): { repo: string; origin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'factory-develop-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'test'), { recursive: true })
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'src/math.ts'), 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  writeFileSync(join(repo, 'test/add.test.ts'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from '../src/math.ts'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
  writeFileSync(
    join(repo, '.agent-factory.json'),
    JSON.stringify({
      ...(config ?? { stack: 'TypeScript', checks: { smoke: 'node -e "process.exit(0)"' }, tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' } }),
      ...(options.merge ? { merge: options.merge } : {}),
    }),
  )
  run('add', '-A')
  run('commit', '-q', '-m', 'base')
  run('remote', 'add', 'origin', origin)
  run('push', '-q', 'origin', 'main')
  return { repo, origin }
}

export const sources = {
  sub: 'export function sub(a: number, b: number): number {\n  return a - b\n}\n',
  mul: 'export function mul(a: number, b: number): number {\n  return a * b\n}\n',
  test: (product: number) =>
    `import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { mul } from '../src/mul.ts'\nimport { sub } from '../src/sub.ts'\n\ntest('sub and mul', () => {\n  assert.equal(sub(5, 3), 2)\n  assert.equal(mul(2, 3), ${product})\n})\n`,
  /** The test that the tests builder submits after the refusal: it passes, but does not test mul yet. */
  subTest: "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { sub } from '../src/sub.ts'\n\ntest('sub', () => {\n  assert.equal(sub(5, 3), 2)\n})\n",
}

const intake = { title: 'Add sub and mul', summary: 'Adds sub() and mul() next to add(), with tests.', slug: 'add-sub-mul', larger: false, passes: 1, reason: 'Two small functions.', questions: [] }

/** A question about the scope of the ask, which only the user can decide (D11). */
export const scopeQuestion = {
  question: 'Add div too?',
  why: 'The ask names sub and mul, and div is the other operation of the four.',
  options: ['No, only sub and mul', 'Yes, add div'],
  recommendation: 'No, only sub and mul',
  level: 'user',
  rule: 'scope',
}

const task = (id: string, files: string[], depends_on: string[] = []) => ({ id, title: `Add ${id}`, work: `Build ${id}.`, files, depends_on })
/** The plan that the scripted planner submits. */
export const plan = {
  smallest_change: 'Two new modules and one test file.',
  goals: ['sub and mul return the right numbers'],
  non_goals: ['No division'],
  done: [{ check: 'The tests pass', command: 'node --test test/ops.test.ts' }],
  sections: [],
  tasks: [task('sub', ['src/sub.ts']), task('mul', ['src/mul.ts']), task('tests', ['test/'], ['sub', 'mul'])],
}

const log = (summary: string, path: string, tests: string[] = []) => `await tools.submit_build_log(${JSON.stringify({ summary, changes: [{ path, why: summary }], tests, blocked: '' })})`

const wrongProduct = {
  location: 'test/ops.test.ts:6',
  title: 'Test mul(2, 3)',
  trigger: 'mul returns a wrong product',
  impact: 'no test finds the wrong product',
  severity: 'high',
  evidence: 'assert.equal(sub(5, 3), 2)',
  recommendation: 'expect 6 from mul(2, 3)',
}

/**
 * The scripted development agents. The sub builder tries to write outside its scope, the tests builder tries to
 * commit a log file and then commits a test with a wrong expectation. The host refuses that log because the test
 * fails, so the builder submits a test of sub only. The fixer of each repair round shows /review/repair.txt, adds mul to
 * the test, and writes its round to test/rounds.txt, so that each round makes a commit. Reviewers find nothing, unless
 * `reviewFix`: then the bugs reviewer finds the missing mul test and the patch agent adds it.
 * With `askScope`, the intake agent raises one user question about the scope.
 */
export function developScript(options: { blockSub?: boolean; reviewFix?: boolean; askScope?: boolean } = {}): Script {
  return ({ role, output, request }) => {
    if (output !== null) return { text: 'done' }
    switch (role) {
      case 'bugs':
        return { cell: `await tools.submit_findings({ findings: ${JSON.stringify(options.reviewFix ? [wrongProduct] : [])} }); text('submitted')` }
      case 'patch':
        return {
          cell: [
            `await tools.Write({ file_path: '/repo/test/ops.test.ts', content: ${JSON.stringify(sources.test(6))} })`,
            `await tools.submit_patch_log({ applied: [{ id: 'bugs-001', change: 'expect 6' }], skipped: [] })`,
          ].join('\n'),
        }
      case 'intake':
        return { cell: `await tools.submit_intake(${JSON.stringify(options.askScope ? { ...intake, questions: [scopeQuestion] } : intake)})` }
      case 'planner':
        return { cell: `await tools.submit_plan(${JSON.stringify(plan)})` }
      case 'builder': {
        // The session of the fixer keeps the prompts of the earlier rounds, so the last prompt gives the round.
        const round = [...request.matchAll(/Repair round (\d+) of/g)].at(-1)?.[1]
        if (round) {
          const summary = `repair ${round}: mul(2, 3) is 6`
          const changes = ['test/ops.test.ts', 'test/rounds.txt'].map((path) => ({ path, why: summary }))
          return {
            cell: [
              `text('repair.txt: ' + await tools.Read({ file_path: '/review/repair.txt' }))`,
              `await tools.Write({ file_path: '/repo/test/ops.test.ts', content: ${JSON.stringify(sources.test(6))} })`,
              `await tools.Write({ file_path: '/repo/test/rounds.txt', content: 'repair round ${round}\\n' })`,
              `await tools.checkpoint({ message: 'repair ${round}' })`,
              `await tools.submit_build_log(${JSON.stringify({ summary, changes, tests: ['test/ops.test.ts'], blocked: '' })})`,
            ].join('\n'),
          }
        }
        const id = /Build task ([a-z]+)/.exec(request)?.[1]
        if (id === 'sub' && options.blockSub)
          return { cell: `await tools.submit_build_log({ summary: 'not built', changes: [], tests: [], blocked: 'sub needs a package that is not installed' })` }
        if (id === 'sub' || id === 'mul')
          return {
            cell: [
              `try { await tools.Write({ file_path: '/repo/src/${id === 'sub' ? 'mul' : 'sub'}.ts', content: 'x' }); text('SCOPE WRITE ALLOWED') } catch (error) { text('scope refused: ' + error) }`,
              `await tools.Write({ file_path: '/repo/src/${id}.ts', content: ${JSON.stringify(sources[id])} })`,
              ...(id === 'sub' ? [`text('checks: ' + JSON.stringify(await tools.run_checks({})))`] : []),
              `text(JSON.stringify(await tools.checkpoint({ message: 'add ${id}' })))`,
              log(`${id} works`, `src/${id}.ts`),
            ].join('\n'),
          }
        return {
          cell: [
            `await tools.Write({ file_path: '/repo/test/run.log', content: 'scratch' })`,
            `try { await tools.checkpoint({ message: 'tests' }); text('LOG COMMITTED') } catch (error) { text('checkpoint refused: ' + error) }`,
            `await tools.Bash({ command: 'rm /repo/test/run.log' })`,
            `await tools.Write({ file_path: '/repo/test/ops.test.ts', content: ${JSON.stringify(sources.test(5))} })`,
            `await tools.checkpoint({ message: 'test sub and mul' })`,
            `try { ${log('tests for sub and mul', 'test/ops.test.ts', ['test/ops.test.ts'])}; text('FAILING LOG ACCEPTED') } catch (error) { text('submit refused: ' + error) }`,
            `await tools.Write({ file_path: '/repo/test/ops.test.ts', content: ${JSON.stringify(sources.subTest)} })`,
            `await tools.checkpoint({ message: 'test sub' })`,
            log('tests for sub', 'test/ops.test.ts', ['test/ops.test.ts']),
          ].join('\n'),
        }
      }
      case 'questions':
        return { cell: `await tools.submit_questions({ questions: [] })` }
      case 'intent':
        return { cell: `await tools.submit_verdict({ satisfied: true, gaps: [], summary: 'sub and mul work' })` }
      default:
        return { cell: `await tools.submit_findings({ findings: [] }); text('submitted')` }
    }
  }
}

/**
 * PRs and CI in memory. `ci` gives the result of each pushed commit in order: the first is red, the next ones green.
 * With `stale`, the first look at each commit finds only an old finished job, as when another branch ran CI on it.
 * While `state.noCi` is true, no commit has CI. `merge` gives the result of each merge call, or throws: by default
 * the merge succeeds with `mergeCommit`.
 */
export function fakePulls(ci: boolean[] = [false], options: { stale?: boolean; merge?: (call: MergeCall) => MergeResult } = {}) {
  const state = {
    opened: [] as { head: string; title: string; body: string }[],
    ready: [] as number[],
    merges: [] as MergeCall[],
    comments: [] as string[],
    shas: [] as string[],
    looks: {} as Record<string, number>,
    noCi: false,
  }
  const pulls: PullRequests = {
    async open(options) {
      state.opened.push(options)
      return { number: 9, url: 'https://github.com/acme/app/pull/9' }
    },
    async ready(pr) {
      state.ready.push(pr)
    },
    async merge(pr, { method, sha }) {
      const call = { pr, method, sha }
      state.merges.push(call)
      return options.merge ? options.merge(call) : { merged: true, sha: mergeCommit }
    },
    async comment(_pr, body) {
      state.comments.push(body)
    },
    async ci(sha): Promise<CiJob[]> {
      if (state.noCi) return []
      if (!state.shas.includes(sha)) state.shas.push(sha)
      state.looks[sha] = (state.looks[sha] ?? 0) + 1
      const job = (created: string, name: string) => ({ created, done: true, name, ok: ci[state.shas.indexOf(sha)] ?? true, run: 1, url: `https://ci.example/${sha}` })
      const old = job(new Date(Date.now() - 3_600_000).toISOString(), 'CI (push, another branch)')
      if (options.stale && state.looks[sha] === 1) return [old]
      return [...(options.stale ? [old] : []), job(new Date().toISOString(), 'CI (pull_request)')]
    },
    async failureLog() {
      return 'test/ops.test.ts: no test of mul(2, 3)'
    },
  }
  return { pulls, state }
}

/** Wraps `pulls` so that the first look at the CI of the `nth` commit (from 1) pauses the run, as when CI is slow. */
export function pauseAtCi(pulls: PullRequests, nth: number): PullRequests {
  const seen: string[] = []
  let paused = false
  return {
    ...pulls,
    async ci(sha) {
      if (!seen.includes(sha)) seen.push(sha)
      if (!paused && seen.length === nth) {
        paused = true
        throw new PausedError(`waiting for CI on ${sha.slice(0, 12)}`)
      }
      return pulls.ci(sha)
    },
  }
}

/**
 * Review passes that the test gives in place of the review loop, in order: each item is the failed criteria of a pass,
 * and an empty list is a PASS. A pass makes no fixes. Each request goes to `requests`.
 */
export function scriptedReview(passes: Criterion[][], requests: ReviewRequest[]): DevelopDeps['review'] {
  return async (request) => {
    requests.push(request)
    const failed = passes.shift()
    if (!failed) throw new Error('no scripted review pass left')
    const criteria = [{ name: 'Checks green', ok: true, detail: 'smoke=pass' }, ...failed]
    const usage = { tokens: zeroTokens(), usd: 0, unpriced: [] }
    return { pass: failed.length === 0, criteria, branch: 'factory/review', final: request.head, report: '- Triage: `TRIAGE path=full`', usage, stopped: false }
  }
}

export type MergeCall = { pr: number; method: MergeMethod; sha: string }
export const mergeCommit = 'c0ffee'.padEnd(40, '0')

export async function developInput(repo: string, runId: string, options: { issue?: number } = {}): Promise<DevelopInput> {
  const base = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()
  return {
    ask: 'Add sub and mul next to add, with tests.',
    base,
    baseRef: 'main',
    config: await loadRepoConfig(repo),
    models: { develop: defaultDevelopModels, review: defaultModels },
    runId,
    source: `${repo} on main`,
    ...(options.issue ? { issue: options.issue } : {}),
  }
}

/**
 * Runs the development workflow on the Node platform, with a scripted model, fake PRs and CI, and memory channels. The
 * repository has no usable key. `signing` wraps the signing of the Node platform. With `keep`, the local deletes and the
 * worktree removal do nothing, so that a test can read a worktree after the run. `review` replaces the review loop.
 */
export async function runDevelop(
  repo: string,
  runsDir: string,
  options: {
    runId: string
    dispatch: Contracts.RuntimeOptions['dispatch']
    pulls: PullRequests
    channel?: Channel
    input?: DevelopInput
    prices?: Prices
    signing?: (signing: Signing) => Signing
    keep?: boolean
    review?: DevelopDeps['review']
  },
) {
  withoutKey(repo)
  const input = options.input ?? (await developInput(repo, options.runId))
  const deps = await nodeDevelop({
    channel: options.channel ?? memoryChannel().channel,
    ci: { pollMs: 10, startMs: 1_000, waitMs: 5_000 },
    credentials,
    dispatch: options.dispatch,
    input,
    log: () => {},
    module,
    prices: options.prices,
    pulls: options.pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir,
  })
  const branches = options.keep ? { ...deps.branches, deleteLocal: async () => {}, release: async () => {} } : deps.branches
  const signed = options.signing ? { ...deps, signing: options.signing(deps.signing) } : deps
  return { ...(await develop(input, { ...signed, branches, review: options.review ?? deps.review })), dir: deps.dir }
}
