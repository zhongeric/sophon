import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import type { CheckResult } from '../src/core/checks.ts'
import { callBudget, PlannedStop } from '../src/core/planned-stop.ts'
import type { Checker } from '../src/core/platform.ts'
import { codeReviewLoop, type LoopInput, type LoopResult } from '../src/core/workflows/code-review-loop.ts'
import { nodeRun } from '../src/node/platform.ts'
import { credentials, fixed, fixtureRepo, gitSource, loopInput, memoryChannel, module, scriptFor } from './support/fixture.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

const budgetMs = 780_000

/** A command that the end of the alarm call stopped: it has no exit code. */
const killed = (name: string): CheckResult => ({ name, command: 'node --test', status: 'fail', exit_code: null, output: 'ok 1 - add\n[host] killed after 195000 ms' })
const failed = (output: string): CheckResult => ({ name: 'tests', command: 'node --test', status: 'fail', exit_code: 1, output })

/** The clock of the alarm calls of one run. A fake test runner moves it to 30 s before the end of the call. */
function clock() {
  let now = 0
  return {
    now: () => now,
    start: () => {
      now = 0
    },
    end: () => {
      now = budgetMs - 30_000
    },
  }
}

/** The scripted model of one run, for all its calls, and the turns of the calls so far. */
function model(script: Script) {
  const turns: Turn[] = []
  return { turns, dispatch: scriptedDispatch(script, turns) }
}

/** One alarm call of the loop on the Node platform, with a ledger of the call budget. */
async function loopCall(
  repo: string,
  dir: string,
  input: LoopInput,
  options: { now: () => number; checker: (real: Checker) => Checker; dispatch: Contracts.RuntimeOptions['dispatch'] },
) {
  const run = await nodeRun({ config: input.config, runId: input.runId, runsDir: dir, source: gitSource(repo) })
  const ledger = callBudget(run.ledger, { budgetMs, startedAt: 0, now: options.now })
  const logs: string[] = []
  const deps = { ...run, ledger, checker: options.checker(run.checker), channel: memoryChannel().channel, credentials, dispatch: options.dispatch, log: (line: string) => logs.push(line), module }
  const outcome = await codeReviewLoop(input, deps).then(
    (result): { result: LoopResult; error?: undefined } => ({ result }),
    (error: unknown) => ({ error, result: undefined }),
  )
  return { ...outcome, ledger: run.ledger, logs }
}

const patchTurns = (turns: Turn[]) => turns.filter((turn) => turn.role === 'patch')

/** The test runner of the checker: each call takes the next answer, or the real runner when no answer is left. */
function testRunner(answers: (() => CheckResult[])[]) {
  return (real: Checker): Checker => ({ ...real, tests: async (tests) => answers.shift()?.() ?? (real.tests ? real.tests(tests) : []) })
}

const regateNote = 'the gate ran again after the end of a call stopped it'

test('a cut of the targeted tests at a patch submit stops the call, and the next call runs the gate again and passes', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const input = await loopInput(repo, 'regate-pass')
  const time = clock()
  const { turns, dispatch } = model(scriptFor({ tests: false }))
  const cut = () => (time.end(), [killed('tests')])
  const stopped = await loopCall(repo, dir, input, { now: time.now, checker: testRunner([cut]), dispatch })

  assert.ok(stopped.error instanceof PlannedStop, String(stopped.error))
  assert.notEqual(stopped.ledger.get('output:step1.patch'), undefined)
  assert.equal(stopped.ledger.get('step:step1.patch'), undefined)
  assert.ok(stopped.logs.some((line) => line.startsWith('step1.patch: the end of the call stopped the targeted tests of turn 1.')), stopped.logs.join('\n'))
  const branch = stopped.ledger.get<{ result: { branch: string } }>('step:freeze')?.result.branch
  assert.ok(branch)
  assert.equal(execFileSync('git', ['show', `${branch}:src/math.ts`], { cwd: repo }).toString(), fixed)

  time.start()
  const mark = turns.length
  const resumed = await loopCall(repo, dir, input, { now: time.now, checker: (real) => real, dispatch })
  assert.ok(resumed.result, String(resumed.error))
  assert.equal(resumed.result.pass, true, resumed.result.report)
  assert.deepEqual(patchTurns(turns.slice(mark)), [])
  assert.ok(resumed.logs.includes('step1.patch: the gate of turn 1 ran again after the cut: pass'), resumed.logs.join('\n'))
  assert.match(resumed.result.report, new RegExp(`^- Step 1 patch: commit [0-9a-f]{12}; applied: bugs-001 \\(sub returns a - b\\); .*; ${regateNote}$`, 'm'))
})

test('a re-gate that fails gives the same patch session one more turn, and its new log counts', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const input = await loopInput(repo, 'regate-fail')
  const time = clock()
  const base = scriptFor({ tests: false })
  const { turns, dispatch } = model((turn) =>
    turn.role === 'patch' && turn.output === null && turn.request.includes('REGATE FAILURE')
      ? { cell: `await tools.submit_patch_log({ applied: [{ id: 'bugs-001', change: 'sub returns a - b after the re-gate' }], skipped: [{ id: 'clean-001', reason: 'inlining adds nothing' }] })` }
      : base(turn),
  )
  const cut = () => (time.end(), [killed('tests')])
  const stopped = await loopCall(repo, dir, input, { now: time.now, checker: testRunner([cut]), dispatch })
  assert.ok(stopped.error instanceof PlannedStop, String(stopped.error))

  time.start()
  const mark = turns.length
  const resumed = await loopCall(repo, dir, input, { now: time.now, checker: testRunner([() => [failed('not ok 1 - sub\nREGATE FAILURE')]]), dispatch })
  assert.ok(resumed.result, String(resumed.error))
  assert.equal(resumed.result.pass, true, resumed.result.report)
  const followUp = patchTurns(turns.slice(mark)).find((turn) => turn.request.includes('REGATE FAILURE'))
  assert.ok(followUp)
  // The same session: the request also holds the prompt of the first turn.
  assert.match(followUp.request, /Apply the kept findings\./)
  assert.match(followUp.request, /the targeted tests of your edits failed \(test\/add\.test\.ts, test\/sub\.test\.ts\)\. Fix the cause and submit again\./)
  assert.match(followUp.request, /--- tests \(exit code 1\) ---/)
  assert.notEqual(resumed.ledger.get('output:step1.patch:2'), undefined)
  assert.ok(resumed.logs.includes('step1.patch: the gate of turn 1 ran again after the cut: fail'), resumed.logs.join('\n'))
  assert.match(resumed.result.report, new RegExp(`^- Step 1 patch: commit [0-9a-f]{12}; applied: bugs-001 \\(sub returns a - b after the re-gate\\); .*; ${regateNote}$`, 'm'))
})

test('a result with no exit code while the call has time refuses the patch log', async () => {
  const repo = fixtureRepo()
  const input = await loopInput(repo, 'regate-time')
  const { turns, dispatch } = model(scriptFor({ tests: false, breakFirst: true }))
  const run = await loopCall(repo, runsDir(), input, { now: () => 0, checker: testRunner([() => [killed('tests')]]), dispatch })

  assert.ok(run.result, String(run.error))
  assert.equal(run.result.pass, true, run.result.report)
  const output = patchTurns(turns).map((turn) => turn.output ?? '').join('\n')
  assert.match(output, /refused: .*the targeted tests of your edits failed/)
  assert.match(output, /--- tests \(exit code none\) ---/)
  assert.equal(run.ledger.get('cut:step1.patch:1'), undefined)
  assert.ok(!run.result.report.includes(regateNote))
})

test('a cut of the ci commands at a light submit stops the call, and the next call runs the gate again and passes', async () => {
  const repo = fixtureRepo({ light: true })
  const dir = runsDir()
  const given = await loopInput(repo, 'regate-light')
  const input = { ...given, config: { ...given.config, tests: null, ci: { ok: 'node -e "process.exit(0)"' } } }
  const time = clock()
  const { turns, dispatch } = model(scriptFor({ tests: false }))
  const calls: string[][] = []
  const ci = (answers: (() => CheckResult[])[]) => (real: Checker): Checker => ({
    ...real,
    ci: async (changed) => {
      calls.push(changed)
      return answers.shift()?.() ?? (real.ci ? real.ci(changed) : [])
    },
  })
  const cut = () => (time.end(), [killed('ci ok')])
  const stopped = await loopCall(repo, dir, input, { now: time.now, checker: ci([cut]), dispatch })
  assert.ok(stopped.error instanceof PlannedStop, String(stopped.error))
  assert.notEqual(stopped.ledger.get('output:light'), undefined)
  assert.equal(stopped.ledger.get('step:light'), undefined)
  assert.ok(stopped.logs.some((line) => line.startsWith('light: the end of the call stopped the ci commands of turn 1.')), stopped.logs.join('\n'))

  time.start()
  const mark = turns.length
  const resumed = await loopCall(repo, dir, input, { now: time.now, checker: ci([]), dispatch })
  assert.ok(resumed.result, String(resumed.error))
  assert.equal(resumed.result.pass, true, resumed.result.report)
  assert.deepEqual(turns.slice(mark).filter((turn) => turn.role === 'light'), [])
  // The cut submit, then the re-gate.
  assert.equal(calls.length, 2)
  assert.ok(resumed.logs.includes('light: the gate of turn 1 ran again after the cut: pass'), resumed.logs.join('\n'))
  assert.match(resumed.result.report, new RegExp(`^- Light review: commit [0-9a-f]{12}; .*; ${regateNote}$`, 'm'))
})

test('a patch agent whose gate still fails after 4 turns fails the run with the gate output', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const input = await loopInput(repo, 'regate-limit')
  const time = clock()
  const { turns, dispatch } = model(scriptFor({ tests: false }))
  const cut = () => (time.end(), [killed('tests')])
  const fail = () => [failed('not ok 1 - sub\nSTILL FAILING')]
  for (let call = 1; call <= 4; call++) {
    time.start()
    const run = await loopCall(repo, dir, input, { now: time.now, checker: testRunner(call === 1 ? [cut] : [fail, cut]), dispatch })
    assert.ok(run.error instanceof PlannedStop, `call ${call}: ${String(run.error)}`)
    assert.notEqual(run.ledger.get(call === 1 ? 'output:step1.patch' : `output:step1.patch:${call}`), undefined)
  }

  time.start()
  const mark = turns.length
  const last = await loopCall(repo, dir, input, { now: time.now, checker: testRunner([fail]), dispatch })
  assert.ok(last.error instanceof Error && !(last.error instanceof PlannedStop), String(last.error))
  assert.match(last.error.message, /^step1\.patch: the gate failed after 4 turns\n/)
  assert.match(last.error.message, /STILL FAILING/)
  assert.deepEqual(patchTurns(turns.slice(mark)), [])
  assert.equal(last.ledger.get('output:step1.patch:5'), undefined)
})
