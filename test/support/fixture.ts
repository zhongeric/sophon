import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Contracts } from 'nanocode-ts'
import type { Credentials } from '../../src/core/providers.ts'
import { parseAnswers, type Channel, type Question } from '../../src/core/questions.ts'
import { codeReviewLoop, defaultModels, type LoopInput } from '../../src/core/workflows/code-review-loop.ts'
import type { GitSource } from '../../src/node/git.ts'
import { loadRepoConfig, nodeRun } from '../../src/node/platform.ts'
import type { Script } from './scripted-model.ts'

export const module = await WebAssembly.compile(readFileSync(fileURLToPath(import.meta.resolve('nanocode-ts/nanocode_wasm.wasm'))))

export const credentials: Credentials = {
  claude: { endpoint: 'https://api.anthropic.com/v1/messages', subscription: false, headers: () => [] },
  codex: { endpoint: 'https://api.openai.com/v1', subscription: false, headers: () => [] },
}

export const fixed = 'export function add(a: number, b: number): number {\n  return a + b\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n'

/** The fixes of the scripted light agent. */
export const lightFixed = {
  docs: 'version 2, for example the second release\n',
  test: '// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n\nimport {Test} from "forge-std/Test.sol";\n\ncontract VaultTest is Test {\n    function test_deposit_succeeds() public {}\n}\n',
}

/**
 * A repository whose feature branch adds a sub() that adds, with a test that catches it. With `light`, a Foundry
 * repository whose feature branch only changes docs and a test, with a Latin abbreviation and a vague test name.
 */
export function fixtureRepo(options: { light?: boolean } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'factory-repo-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  const write = (path: string, content: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  write('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  write('docs/v1.md', 'version 1\n')
  write('docs/v2.md', 'version 2\n')
  symlinkSync('v1.md', join(repo, 'docs/current.md'))
  write('test/add.test.ts', "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from '../src/math.ts'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
  write(
    '.agent-factory.json',
    JSON.stringify({
      stack: 'TypeScript',
      checks: { syntax: { command: 'node --check {files}', files: '\\.js$' }, smoke: 'node -e "process.exit(0)"' },
      tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' },
    }),
  )
  if (options.light) write('foundry.toml', '[profile.default]\nsolc = "0.8.28"\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'base')
  run('checkout', '-q', '-b', 'feature')
  if (options.light) {
    write('docs/v2.md', 'version 2, e.g. the second release\n')
    write('test/Vault.t.sol', lightFixed.test.replace('test_deposit_succeeds', 'testStuff'))
    run('add', '-A')
    run('commit', '-q', '-m', 'document v2')
    return repo
  }
  write('src/math.ts', fixed.replace('a - b', 'a + b'))
  unlinkSync(join(repo, 'docs/current.md'))
  symlinkSync('v2.md', join(repo, 'docs/current.md'))
  write('test/sub.test.ts', "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { sub } from '../src/math.ts'\n\ntest('sub', () => assert.equal(sub(5, 3), 2))\n")
  run('add', '-A')
  run('commit', '-q', '-m', 'add sub')
  return repo
}

const bug = {
  location: 'src/math.ts:6',
  title: 'Subtract b in sub',
  trigger: 'sub(5, 3)',
  impact: 'returns 8 instead of 2',
  severity: 'critical',
  evidence: 'export function sub(a: number, b: number): number { return a + b',
  recommendation: 'return a - b',
}

const openQuestion = {
  question: 'May sub return a negative number?',
  why: 'The ask does not say what sub(3, 5) returns (src/math.ts).',
  options: ['Yes, return -2', 'No, throw an error'],
  recommendation: 'Yes, return -2',
}

/**
 * The minimize reviewer tries to write and to submit a made-up quote, the bugs reviewer runs the
 * failing test, and the patch agent tries to change the check config.
 */
export const script = scriptFor({ tests: true })

/**
 * The scripted agents. Without `tests`, as on Cloudflare where CI runs the tests, no agent calls run_tests.
 * `holdBug` marks the bug as the user's decision. `rejectBug` makes the patch agent reject it.
 */
export function scriptFor(options: { tests: boolean; holdBug?: boolean; rejectBug?: boolean }): Script {
  const runTests = (code: string) => (options.tests ? [code] : [])
  return ({ role, output }) => {
  if (output !== null) return { text: 'done' }
  const findings = (list: unknown[]) => `await tools.submit_findings({ findings: ${JSON.stringify(list)} }); text('submitted')`
  switch (role) {
    case 'minimize':
      return {
        cell: [
          `try { await tools.Write({ file_path: '/repo/src/math.ts', content: 'x' }); text('WRITE ALLOWED') } catch (error) { text('write refused: ' + error) }`,
          `try { await tools.submit_findings({ findings: [${JSON.stringify({ ...bug, evidence: 'return a * b', severity: 'low' })}] }) } catch (error) { text('rejected: ' + error) }`,
          findings([{ ...bug, title: 'Inline sub', severity: 'low', evidence: 'export function sub' }]),
        ].join('\n'),
      }
    case 'bugs':
      return {
        cell: [
          ...runTests(`text(JSON.stringify(await tools.run_tests({ tests: ['test/sub.test.ts'] })))`),
          findings([options.holdBug ? { ...bug, decision: 'Should sub throw on a negative result?', needs_decision: true } : bug]),
        ].join('\n'),
      }
    case 'patch':
      if (options.rejectBug)
        return {
          cell: `await tools.submit_patch_log({ applied: [], skipped: [{ id: 'bugs-001', reason: 'callers depend on the sum' }, { id: 'min-001', reason: 'inlining adds nothing' }] })`,
        }
      return {
        cell: [
          `await tools.Read({ file_path: '/repo/src/math.ts' })`,
          `await tools.Write({ file_path: '/repo/src/math.ts', content: ${JSON.stringify(fixed)} })`,
          `try { await tools.Write({ file_path: '/repo/.agent-factory.json', content: '{}' }); text('PROTECTED WRITE ALLOWED') } catch (error) { text('protected: ' + error) }`,
          ...runTests(`text(JSON.stringify(await tools.run_tests({ tests: ['test/sub.test.ts'] })))`),
          `text(JSON.stringify(await tools.Bash({ command: 'cat /review/decisions.md /review/gate-log.txt' })))`,
          `await tools.submit_patch_log({ applied: [{ id: 'bugs-001', change: 'sub returns a - b' }], skipped: [{ id: 'min-001', reason: 'inlining adds nothing' }] })`,
        ].join('\n'),
      }
    case 'questions':
      return {
        cell: `await tools.submit_questions({ questions: [${JSON.stringify(openQuestion)}] })`,
      }
    case 'intent':
      return { cell: `await tools.submit_verdict({ satisfied: true, gaps: [], summary: 'sub subtracts b from a' })` }
    case 'light':
      return {
        cell: [
          `try { await tools.Write({ file_path: '/repo/src/math.ts', content: 'x' }); text('CODE WRITE ALLOWED') } catch (error) { text('code refused: ' + error) }`,
          `await tools.Write({ file_path: '/repo/docs/v2.md', content: ${JSON.stringify(lightFixed.docs)} })`,
          `await tools.Write({ file_path: '/repo/test/Vault.t.sol', content: ${JSON.stringify(lightFixed.test)} })`,
          `await tools.submit_light_log({ applied: [{ id: 'host-001', change: 'wrote for example' }, { id: 'host-002', change: 'renamed testStuff to test_deposit_succeeds' }], skipped: [], fixes: [{ location: 'docs/v2.md:1', change: 'kept the release name' }] })`,
        ].join('\n'),
      }
    default:
      return { cell: findings([]) }
  }
  }
}

/** A channel that answers each batch with a scripted reply: `/answer recommended` unless `replies` says otherwise, null to not answer yet. */
export function memoryChannel(replies: Record<string, string | null> = {}) {
  const posted: { batch: string; questions: Question[] }[] = []
  const channel: Channel = {
    async post(_runId, batch, questions) {
      posted.push({ batch, questions })
      return { batch, ref: `memory:${batch}`, at: new Date().toISOString() }
    },
    async answers(where, questions) {
      const reply = where.batch in replies ? replies[where.batch] : '/answer recommended'
      return reply === null || reply === undefined ? null : parseAnswers(reply, questions)
    },
    where: (where) => where.ref,
  }
  return { channel, posted, replies }
}

export const gitSource = (repo: string): GitSource => ({ base: 'main', head: 'feature', repo })

export async function loopInput(repo: string, runId: string): Promise<LoopInput> {
  return {
    ask: 'Add a sub function that subtracts b from a.',
    config: await loadRepoConfig(repo),
    models: defaultModels,
    runId,
    source: `${repo} main..feature`,
  }
}

/** Runs the loop on the fixture with the Node platform, a scripted model, and by default a channel that takes every recommendation. */
export async function runLoop(
  repo: string,
  runId: string,
  runsDir: string,
  options: { dispatch: Contracts.RuntimeOptions['dispatch']; channel?: Channel; input?: LoopInput },
) {
  const input = options.input ?? (await loopInput(repo, runId))
  const run = await nodeRun({ config: input.config, runId, runsDir, source: gitSource(repo) })
  const result = await codeReviewLoop(input, {
    ...run,
    channel: options.channel ?? memoryChannel().channel,
    credentials,
    dispatch: options.dispatch,
    log: () => {},
    module,
  })
  return { ...result, dir: run.dir }
}
