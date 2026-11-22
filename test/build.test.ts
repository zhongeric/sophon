import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentHost } from '../src/core/agent.ts'
import { commandChecker, type Machine } from '../src/core/checks.ts'
import { build, type DevelopContext } from '../src/core/develop-steps.ts'
import type { Checker } from '../src/core/platform.ts'
import { profilesById, type Profile } from '../src/core/profiles.ts'
import { gitBranches } from '../src/node/git.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { loadRepoConfig, sqliteStore } from '../src/node/platform.ts'
import { developRepo } from './support/develop.ts'
import { credentials, module } from './support/fixture.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

const changedMath = 'export function add(a: number, b: number): number {\n  return b + a\n}\n'
const write = `await tools.Write({ file_path: '/repo/src/math.ts', content: ${JSON.stringify(changedMath)} })`
const checkpoint = `await tools.checkpoint({ message: 'swap' })`
const log = (blocked = '', remaining?: string) =>
  `await tools.submit_build_log(${JSON.stringify({ summary: 'add', changes: [{ path: 'src/math.ts', why: 'add' }], tests: [], blocked, ...(remaining === undefined ? {} : { remaining }) })})`
const trySubmit = `try { ${log()}; text('LOG ACCEPTED') } catch (error) { text('submit refused: ' + error) }`

/** A machine that answers each command from `answer` and keeps the commands. */
function fakeMachine(answer: (command: string) => { exit_code: number | null; output: string }) {
  const commands: string[] = []
  const machine: Machine = {
    async run(command) {
      commands.push(command)
      return answer(command)
    },
  }
  return { commands, machine }
}

/** Keeps the options of each checks() call and the files of each tests() and ci() call. */
function recorded(inner: Checker) {
  const calls = { checks: [] as ({ tests?: boolean } | undefined)[], tests: [] as string[][], ci: [] as string[][] }
  const run = inner.tests
  const ci = inner.ci
  const checker: Checker = {
    checks(changed, options) {
      calls.checks.push(options)
      return inner.checks(changed, options)
    },
    tests: run
      ? (tests) => {
          calls.tests.push(tests)
          return run(tests)
        }
      : null,
    ...(ci
      ? {
          ci: (changed: string[]) => {
            calls.ci.push(changed)
            return ci(changed)
          },
        }
      : {}),
  }
  return { calls, checker }
}

/**
 * One build() on a new git branch of developRepo, with a scripted model and the checks on `machine`. Without `script`,
 * the model runs `cell` at the start of each turn. `timeLeft` is the time that the alarm call has left.
 */
async function buildWith(options: { cell: string; machine: Machine; config?: Record<string, unknown>; script?: Script; timeLeft?: () => number; baseFiles?: Record<string, string>; active?: Profile[] }) {
  const { repo } = developRepo(options.config)
  const dir = mkdtempSync(join(tmpdir(), 'factory-build-'))
  const config = await loadRepoConfig(repo)
  const base = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim()
  const branch = await gitBranches(repo, join(dir, 'branches')).branch('factory/task-build-add', base)
  for (const [path, content] of Object.entries(options.baseFiles ?? {})) await branch.tree.write(path, new TextEncoder().encode(content))
  const { calls, checker } = recorded(commandChecker(branch, config, options.machine))
  const turns: Turn[] = []
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger: { ...fileLedger(join(dir, 'state.json')), ...(options.timeLeft ? { timeLeft: options.timeLeft } : {}) },
    credentials,
    dispatch: scriptedDispatch(options.script ?? ((turn) => (turn.output === null ? { cell: options.cell } : { text: 'done' })), turns),
    log: () => {},
  }
  const context: DevelopContext = { host, config, guides: { read: () => '', mounts: {} }, stackGuides: [], ask: 'Change add.' }
  const result = await build(context, {
    id: 'build.add',
    turn: { request: 'task', key: 'output:build.add' },
    model: { provider: 'claude', model: 'claude-opus-5-5' },
    branch,
    scope: ['src/'],
    active: options.active ?? [],
    checker,
    base,
    ...(options.baseFiles ? { baseFiles: Object.keys(options.baseFiles) } : {}),
    review: {},
    prompt: 'Build task add.',
    label: 'agent-factory: add',
  })
  const output = turns.map((turn) => turn.output ?? '').join('\n')
  return { calls, host, output, result, turns }
}

const pass = { exit_code: 0, output: 'ok' }

test('build: checkpoint refuses edits to inherited base files before and after a commit', { timeout: 60_000 }, async () => {
  const { machine } = fakeMachine(() => pass)
  const inherited = 'pragma solidity ^0.8.28;\ncontract Base {\n  function caller() external view returns (address) { return msg.sender; }\n}\n'
  const replace = (content: string) => `await tools.Write({ file_path: '/repo/src/Base.sol', content: ${JSON.stringify(content)} })`
  const unsafe = replace(inherited.replace('msg.sender', 'tx.origin'))
  const tryCheckpoint = `try { ${checkpoint}; text('UNSAFE CHECKPOINT ACCEPTED') } catch (error) { text('edit refused: ' + error) }`
  const cell = [
    write, unsafe, tryCheckpoint,
    replace(inherited), checkpoint,
    unsafe, tryCheckpoint,
    `await tools.Bash({ command: 'rm /repo/src/Base.sol' })`, tryCheckpoint,
    replace(inherited), trySubmit,
  ].join('\n')
  const { output, result } = await buildWith({ cell, machine, baseFiles: { 'src/Base.sol': inherited }, active: profilesById(['solidity']) })

  assert.equal(output.match(/edit refused: Error: checkpoint refused: restore the unchanged files from the base merge: src\/Base\.sol/g)?.length, 3)
  assert.doesNotMatch(output, /UNSAFE CHECKPOINT ACCEPTED/)
  assert.match(output, /LOG ACCEPTED/)
  assert.equal(result.blocked, '')
})

test('build: submit refuses a reverted base file even when the tree matches HEAD', { timeout: 60_000 }, async () => {
  const { machine } = fakeMachine(() => pass)
  const original = changedMath.replace('b + a', 'a + b')
  const cell = [
    `await tools.Write({ file_path: '/repo/src/math.ts', content: ${JSON.stringify(original)} })`, trySubmit,
    write, checkpoint, trySubmit,
  ].join('\n')
  const { output, result } = await buildWith({ cell, machine, baseFiles: { 'src/math.ts': changedMath } })

  assert.match(output, /submit refused: Error: submit refused: restore the unchanged files from the base merge: src\/math\.ts/)
  assert.equal(output.match(/LOG ACCEPTED/g)?.length, 1)
  assert.equal(result.blocked, '')
})

test('build: in a base merge, the submit runs no targeted test of the files that the base brings unchanged', { timeout: 60_000 }, async () => {
  const { machine } = fakeMachine(() => pass)
  const own = `await tools.Write({ file_path: '/repo/src/extra.ts', content: 'export const extra = 1\\n' })`
  const submit = `await tools.submit_build_log(${JSON.stringify({ summary: 'merge', changes: [{ path: 'src/extra.ts', why: 'resolve' }], tests: [], blocked: '' })}); text('LOG ACCEPTED')`
  const { calls, output, result } = await buildWith({ cell: [own, checkpoint, submit].join('\n'), machine, baseFiles: { 'src/math.ts': changedMath } })

  assert.match(output, /LOG ACCEPTED/)
  // test/add.test.ts imports only src/math.ts, which the base brings: the CI of the base tested it.
  assert.deepEqual(calls.tests, [])
  assert.equal(result.blocked, '')
})

test('build: run_checks runs only the configured checks, and submit runs the targeted tests and accepts the log when they pass', { timeout: 60_000 }, async () => {
  const { commands, machine } = fakeMachine(() => pass)
  const cell = [write, checkpoint, `text('checks: ' + JSON.stringify(await tools.run_checks({})))`, trySubmit].join('\n')
  const { calls, output, result } = await buildWith({ cell, machine })

  assert.deepEqual(calls.checks, [{ tests: false }])
  assert.deepEqual(calls.tests, [['test/add.test.ts']])
  assert.equal(commands.length, 2)
  assert.equal(commands[0], 'node -e "process.exit(0)"')
  assert.match(commands[1]!, /node --test 'test\/add\.test\.ts'$/)
  assert.match(output, /checks: .*smoke.*pass/)
  assert.doesNotMatch(output, /no targeted tests/)
  assert.match(output, /LOG ACCEPTED/)
  assert.equal(result.blocked, '')
})

test('build: submit refuses the log when a targeted test fails, with the end of its output, and a second submit works', { timeout: 60_000 }, async () => {
  let runs = 0
  const { machine } = fakeMachine((command) => {
    if (!command.includes('--test')) return pass
    runs++
    return runs === 1 ? { exit_code: 1, output: `START OF OUTPUT ${'x'.repeat(6_000)} not ok 1 - add: expected 5` } : pass
  })
  const cell = [write, checkpoint, trySubmit, trySubmit].join('\n')
  const { calls, output, result } = await buildWith({ cell, machine })

  assert.match(output, /submit refused: .*the targeted tests failed \(test\/add\.test\.ts\)\. Fix the cause, checkpoint and submit again.*--- tests \(exit code 1\) ---.*not ok 1 - add: expected 5/)
  assert.doesNotMatch(output, /START OF OUTPUT/)
  assert.match(output, /LOG ACCEPTED/)
  assert.deepEqual(calls.tests, [['test/add.test.ts'], ['test/add.test.ts']])
  assert.equal(result.blocked, '')
})

test('build: submit runs ci after the targeted tests, and refuses the log while a ci command fails, with the end of its output', { timeout: 60_000 }, async () => {
  let runs = 0
  const { commands, machine } = fakeMachine((command) => {
    if (command !== 'npm run lint') return pass
    runs++
    return runs === 1 ? { exit_code: 1, output: `START OF OUTPUT ${'x'.repeat(6_000)} src/math.ts:2 operands swapped` } : pass
  })
  const config = {
    stack: 'TypeScript',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' },
    ci: { lint: 'npm run lint', docs: { command: 'markdownlint {files}', files: '\\.md$' } },
  }
  const cell = [write, checkpoint, trySubmit, trySubmit].join('\n')
  const { calls, output, result } = await buildWith({ cell, machine, config })

  assert.match(output, /submit refused: .*the ci commands failed \(ci lint\)\. Fix the cause, checkpoint and submit again.*--- ci lint \(exit code 1\) ---.*src\/math\.ts:2 operands swapped/)
  assert.doesNotMatch(output, /START OF OUTPUT/)
  assert.match(output, /LOG ACCEPTED/)
  assert.deepEqual(calls.tests, [['test/add.test.ts'], ['test/add.test.ts']])
  assert.deepEqual(calls.ci, [['src/math.ts'], ['src/math.ts']])
  assert.equal(commands.length, 4)
  assert.match(commands[0]!, /node --test 'test\/add\.test\.ts'$/)
  assert.equal(commands[1], 'npm run lint')
  assert.equal(result.blocked, '')
})

test('build: submit refuses the log when the setup fails, with the end of the setup output', { timeout: 60_000 }, async () => {
  const { commands, machine } = fakeMachine((command) => (command === 'npm ci' ? { exit_code: 2, output: `${'y'.repeat(6_000)} npm ERR! lockfile is out of date` } : pass))
  const config = {
    stack: 'TypeScript',
    setup: 'npm ci',
    checks: { smoke: 'node -e "process.exit(0)"' },
    tests: { pattern: '\\.test\\.ts$', command: 'env -u NODE_TEST_CONTEXT node --test {tests}' },
  }
  const cell = [write, checkpoint, trySubmit, log('npm ci fails')].join('\n')
  const { output, result } = await buildWith({ cell, machine, config })

  assert.match(output, /submit refused: .*the setup failed, so the targeted tests \(test\/add\.test\.ts\) did not run\. Fix the cause.*--- setup \(exit code 2\) ---.*npm ERR! lockfile is out of date/)
  assert.doesNotMatch(output, /LOG ACCEPTED/)
  assert.deepEqual(commands, ['npm ci'])
  assert.equal(result.blocked, 'npm ci fails')
})

test('build: a blocked log runs no tests', { timeout: 60_000 }, async () => {
  const { commands, machine } = fakeMachine(() => pass)
  const cell = [write, checkpoint, log('add needs a decision')].join('\n')
  const { calls, result } = await buildWith({ cell, machine })

  assert.equal(result.blocked, 'add needs a decision')
  assert.deepEqual(calls.checks, [])
  assert.deepEqual(calls.tests, [])
  assert.deepEqual(commands, [])
})

test('build: with less than a minute left in the call, the tools run no command, and a new turn of the session continues the task', { timeout: 60_000 }, async () => {
  const { commands, machine } = fakeMachine(() => pass)
  let left = 30_000
  const first = [write, checkpoint, `try { await tools.run_checks({}) } catch (error) { text('checks refused: ' + error) }`, log('', 'run the checks, then submit')].join('\n')
  // The second turn has the full call: the host runs the targeted tests at its submit.
  const script: Script = (turn) => {
    if (turn.output !== null) return { text: 'done' }
    if (!/What is left: run the checks, then submit/.test(turn.request)) return { cell: first }
    left = 600_000
    return { cell: trySubmit }
  }
  const { calls, host, output, result, turns } = await buildWith({ cell: '', machine, script, timeLeft: () => left })

  assert.match(output, /checks refused: Error: the alarm call of this run has 30 s left, so this turn runs no more commands\. Call submit_build_log now, with what is left to do in remaining\./)
  assert.match(output, /LOG ACCEPTED/)
  assert.deepEqual(calls.checks, [])
  assert.deepEqual(calls.tests, [['test/add.test.ts']])
  assert.equal(commands.length, 1)
  assert.equal(host.ledger.get<{ remaining: string }>('output:build.add')?.remaining, 'run the checks, then submit')
  assert.equal(result.remaining, undefined)
  assert.equal(result.blocked, '')
  // The second turn is in the same session: its request has the prompt of the first turn.
  const second = turns.find((turn) => /What is left:/.test(turn.request))!
  assert.match(second.request, /Build task add\./)
})

test('build: when the end of the call stops the targeted tests of a submit, the host accepts the log with remaining, and the next turn runs them again', { timeout: 60_000 }, async () => {
  let left = 200_000
  let runs = 0
  // The first test run uses the rest of the call, and the box stops it at the end of the call.
  const { machine } = fakeMachine(() => {
    if (++runs > 1) return pass
    left = 5_000
    return { exit_code: null, output: 'ok 1 - add\n[host] killed after 195000 ms' }
  })
  const script: Script = (turn) => {
    if (turn.output !== null) return { text: 'done' }
    if (!/What is left:/.test(turn.request)) return { cell: [write, checkpoint, trySubmit].join('\n') }
    left = 600_000
    return { cell: trySubmit }
  }
  const { calls, host, result } = await buildWith({ cell: '', machine, script, timeLeft: () => left })

  assert.match(host.ledger.get<{ remaining: string }>('output:build.add')?.remaining ?? '', /The end of the alarm call stopped the targeted tests/)
  assert.deepEqual(calls.tests, [['test/add.test.ts'], ['test/add.test.ts']])
  assert.equal(result.blocked, '')
  assert.equal(result.remaining, undefined)
})

test('build: a test run with no exit code while the call has time is a failure, as before', { timeout: 60_000 }, async () => {
  let runs = 0
  const { machine } = fakeMachine(() => (++runs > 1 ? pass : { exit_code: null, output: '[host] killed after 1800000 ms' }))
  const cell = [write, checkpoint, trySubmit, trySubmit].join('\n')
  const { output, result } = await buildWith({ cell, machine, timeLeft: () => 600_000 })
  assert.match(output, /submit refused: Error: the targeted tests failed/)
  assert.match(output, /LOG ACCEPTED/)
  assert.equal(result.remaining, undefined)
})

test('build: remaining is refused while the call has time, also on a platform without call limits', { timeout: 60_000 }, async () => {
  const { machine } = fakeMachine(() => pass)
  const cell = [write, checkpoint, `try { ${log('', 'more work')} } catch (error) { text('remaining refused: ' + error) }`, trySubmit].join('\n')
  for (const timeLeft of [undefined, () => 600_000]) {
    const { output, result } = await buildWith({ cell, machine, ...(timeLeft ? { timeLeft } : {}) })
    assert.match(output, /remaining refused: Error: remaining is only for a turn whose alarm call has no time left/)
    assert.match(output, /LOG ACCEPTED/)
    assert.equal(result.remaining, undefined)
  }
})

test('build: a task that is out of time at the end of each of its 4 turns is blocked, with what is left', { timeout: 60_000 }, async () => {
  const { commands, machine } = fakeMachine(() => pass)
  const cell = [`try { await tools.checkpoint({ message: 'x' }) } catch {}`, write, log('', 'finish add')].join('\n')
  const { result, turns } = await buildWith({ cell, machine, timeLeft: () => 10_000 })

  assert.equal(turns.filter((turn) => turn.output === null).length, 4)
  assert.equal(result.blocked, 'the task did not finish in 4 turns. What is left: finish add')
  assert.equal(result.remaining, '')
  assert.deepEqual(commands, [])
})
