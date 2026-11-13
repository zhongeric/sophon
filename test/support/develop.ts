import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Contracts } from 'nanocode-ts'
import type { CiJob } from '../../src/core/ci.ts'
import type { PullRequests } from '../../src/core/platform.ts'
import type { Channel } from '../../src/core/questions.ts'
import { defaultModels } from '../../src/core/workflows/code-review-loop.ts'
import { defaultDevelopModels, develop, type DevelopInput } from '../../src/core/workflows/develop.ts'
import { loadRepoConfig, nodeDevelop } from '../../src/node/platform.ts'
import { credentials, memoryChannel, module } from './fixture.ts'
import type { Script } from './scripted-model.ts'

/** A repository with add() on main, and a bare origin that the run pushes to. `config` replaces the checks config. */
export function developRepo(config?: Record<string, unknown>): { repo: string; origin: string } {
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
    JSON.stringify(config ?? { stack: 'TypeScript', checks: { smoke: 'node -e "process.exit(0)"' }, tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' } }),
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
}

const intake = { title: 'Add sub and mul', summary: 'Adds sub() and mul() next to add(), with tests.', slug: 'add-sub-mul', larger: false, passes: 1, reason: 'Two small functions.', questions: [] }

const task = (id: string, files: string[], depends_on: string[] = []) => ({ id, title: `Add ${id}`, work: `Build ${id}.`, files, depends_on })
const plan = {
  smallest_change: 'Two new modules and one test file.',
  goals: ['sub and mul return the right numbers'],
  non_goals: ['No division'],
  done: [{ check: 'The tests pass', command: 'node --test test/ops.test.ts' }],
  sections: [],
  tasks: [task('sub', ['src/sub.ts']), task('mul', ['src/mul.ts']), task('tests', ['test/'], ['sub', 'mul'])],
}

const log = (summary: string, path: string, tests: string[] = []) => `await tools.submit_build_log(${JSON.stringify({ summary, changes: [{ path, why: summary }], tests, blocked: '' })})`

const wrongProduct = {
  location: 'test/ops.test.ts:8',
  title: 'Expect 6 from mul(2, 3)',
  trigger: 'the test runs mul(2, 3)',
  impact: 'the test fails on correct code',
  severity: 'high',
  evidence: 'assert.equal(mul(2, 3), 5)',
  recommendation: 'expect 6',
}

/**
 * The scripted development agents. The sub builder tries to write outside its scope, the tests builder tries to
 * commit a log file and then commits a test with a wrong expectation, and the CI fixer corrects it. Reviewers find
 * nothing, unless `reviewFix`: then the bugs reviewer finds the wrong expectation and the patch agent corrects it.
 */
export function developScript(options: { blockSub?: boolean; reviewFix?: boolean } = {}): Script {
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
        return { cell: `await tools.submit_intake(${JSON.stringify(intake)})` }
      case 'planner':
        return { cell: `await tools.submit_plan(${JSON.stringify(plan)})` }
      case 'builder': {
        if (request.includes('Fix the CI failure'))
          return {
            cell: [
              `await tools.Write({ file_path: '/repo/test/ops.test.ts', content: ${JSON.stringify(sources.test(6))} })`,
              `await tools.checkpoint({ message: 'expect 6' })`,
              log('mul(2, 3) is 6', 'test/ops.test.ts', ['test/ops.test.ts']),
            ].join('\n'),
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
            log('tests for sub and mul', 'test/ops.test.ts', ['test/ops.test.ts']),
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
 */
export function fakePulls(ci: boolean[] = [false], options: { stale?: boolean } = {}) {
  const state = { opened: [] as { head: string; title: string; body: string }[], ready: [] as number[], comments: [] as string[], shas: [] as string[], looks: {} as Record<string, number> }
  const pulls: PullRequests = {
    async open(options) {
      state.opened.push(options)
      return { number: 9, url: 'https://github.com/acme/app/pull/9' }
    },
    async ready(pr) {
      state.ready.push(pr)
    },
    async comment(_pr, body) {
      state.comments.push(body)
    },
    async ci(sha): Promise<CiJob[]> {
      if (!state.shas.includes(sha)) state.shas.push(sha)
      state.looks[sha] = (state.looks[sha] ?? 0) + 1
      const job = (created: string, name: string) => ({ created, done: true, name, ok: ci[state.shas.indexOf(sha)] ?? true, run: 1, url: `https://ci.example/${sha}` })
      const old = job(new Date(Date.now() - 3_600_000).toISOString(), 'CI (push, another branch)')
      if (options.stale && state.looks[sha] === 1) return [old]
      return [...(options.stale ? [old] : []), job(new Date().toISOString(), 'CI (pull_request)')]
    },
    async failureLog() {
      return 'test/ops.test.ts: mul(2, 3): expected 5, got 6'
    },
  }
  return { pulls, state }
}

export function developInput(repo: string, runId: string): DevelopInput {
  const base = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()
  return {
    ask: 'Add sub and mul next to add, with tests.',
    base,
    baseRef: 'main',
    config: loadRepoConfig(join(repo, '.agent-factory.json')),
    models: { develop: defaultDevelopModels, review: defaultModels },
    runId,
    source: `${repo} on main`,
  }
}

/** Runs the development workflow on the Node platform, with a scripted model, fake PRs and CI, and memory channels. */
export async function runDevelop(
  repo: string,
  runsDir: string,
  options: { runId: string; dispatch: Contracts.RuntimeOptions['dispatch']; pulls: PullRequests; channel?: Channel; input?: DevelopInput },
) {
  const input = options.input ?? developInput(repo, options.runId)
  const deps = await nodeDevelop({
    channel: options.channel ?? memoryChannel().channel,
    ci: { pollMs: 10, startMs: 1_000, waitMs: 5_000 },
    credentials,
    dispatch: options.dispatch,
    input,
    log: () => {},
    module,
    pulls: options.pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir,
  })
  return { ...(await develop(input, deps)), dir: deps.dir }
}
