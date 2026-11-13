import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PausedError, type Channel } from '../src/core/questions.ts'
import { defaultModels } from '../src/core/workflows/code-review-loop.ts'
import { fixed, fixtureRepo, loopInput, memoryChannel, runLoop, script, scriptFor } from './support/fixture.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-runs-'))

test('the loop reviews, gates, patches, swaps families, checks and passes', async () => {
  const repo = fixtureRepo()
  const turns: Turn[] = []
  const result = await runLoop(repo, 'e2e', runsDir(), { dispatch: scriptedDispatch(script, turns) })

  assert.equal(result.pass, true, result.report)
  assert.equal(execFileSync('git', ['show', `${result.branch}:src/math.ts`], { cwd: repo }).toString(), fixed)

  const outputs = (role: string) => turns.filter((turn) => turn.role === role && turn.output).map((turn) => turn.output!).join('\n')
  assert.match(outputs('minimize'), /write refused: .*Read-only file system/)
  assert.match(outputs('minimize'), /rejected: .*evidence \\"return a \* b\\" is not in src\/math.ts/)
  assert.match(outputs('bugs'), /"status\\":\\"fail/)
  assert.match(outputs('patch'), /protected: .*EACCES/)
  assert.match(outputs('patch'), /"status\\":\\"pass/)

  const providers = (role: string) => new Set(turns.filter((turn) => turn.role === role).map((turn) => turn.provider))
  for (const role of ['minimize', 'bugs', 'anti-slop', 'patch', 'questions', 'late-rules', 'intent']) assert.deepEqual(providers(role), new Set(['claude']))
  for (const role of ['rules', 'late-minimize', 'late-bugs']) assert.deepEqual(providers(role), new Set(['codex']))

  const gateLog = readFileSync(join(result.dir, 'gate-log.txt'), 'utf8')
  assert.match(gateLog, /# Step 1 \| model_family=claude\+codex \| minimize=claude-opus-5-5 rules=gpt-6.1-sol bugs=claude-fable-5-2/)
  assert.match(gateLog, /# Step 2 \| model_family=codex\+claude \| late-minimize=gpt-6.1-sol late-rules=claude-fable-5-2/)
  assert.match(gateLog, /FINDING bugs-001 \| track=bugs \| severity=critical \| ACTION=keep/)
  assert.match(gateLog, /FINDING min-001 \| track=minimize \| severity=low \| ACTION=keep/)
  assert.match(result.report, /skipped: min-001 \(inlining adds nothing\)/)
  assert.equal(readFileSync(join(result.dir, 'report.md'), 'utf8'), result.report)
})

test('a resumed run does not repeat finished steps', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const down: Channel = { ...memoryChannel().channel, answers: async () => { throw new Error('the channel is down') } }
  const first: Turn[] = []
  await assert.rejects(runLoop(repo, 'resume', dir, { channel: down, dispatch: scriptedDispatch(script, first) }), /the channel is down/)
  assert.ok(first.some((turn) => turn.role === 'bugs'))

  const second: Turn[] = []
  const result = await runLoop(repo, 'resume', dir, { dispatch: scriptedDispatch(script, second) })
  assert.equal(result.pass, true)
  for (const role of ['minimize', 'rules', 'bugs', 'anti-slop']) assert.ok(!second.some((turn) => turn.role === role), `${role} ran again`)
  assert.ok(second.some((turn) => turn.role === 'patch'))
})

test('a run that crashed right after a patch commit keeps that commit when it resumes', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  await runLoop(repo, 'crash', dir, { dispatch: scriptedDispatch(script, []) })

  // Forget every step from the step 1 patch on, as if the host died after the commit and before the record.
  const path = join(dir, 'crash', 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const keys = Object.keys(state)
  for (const key of keys.slice(keys.indexOf('step:step1.gate') + 1)) if (key.startsWith('step:') || key === 'result') delete state[key]
  writeFileSync(path, JSON.stringify(state))

  const result = await runLoop(repo, 'crash', dir, { dispatch: scriptedDispatch(script, []) })
  assert.equal(result.pass, true)
  assert.match(result.report, /Step 1 patch: commit [0-9a-f]{12}/)
  assert.equal(execFileSync('git', ['show', `${result.branch}:src/math.ts`], { cwd: repo }).toString(), fixed)
})

test('the loop stops before any work when step 2 does not swap families', async () => {
  const repo = fixtureRepo()
  const input = loopInput(repo, 'same-family')
  input.models = { ...defaultModels, step2: { ...defaultModels.step2, 'late-rules': { provider: 'codex', model: 'gpt-6.1-sol' } } }
  const turns: Turn[] = []
  await assert.rejects(runLoop(repo, 'same-family', runsDir(), { dispatch: scriptedDispatch(script, turns), input }), /step 2 late-rules and step 1 rules both use codex/)
  assert.equal(turns.length, 0)
})

test('the user answers the open questions before the gate, and decides the findings that need a decision', async () => {
  const repo = fixtureRepo()
  const turns: Turn[] = []
  const { channel, posted } = memoryChannel({ ask: '/answer\nQ1: b', 'step1.gate': '/answer\nQ1: fix it, and keep add() as it is' })
  const result = await runLoop(repo, 'decide', runsDir(), { channel, dispatch: scriptedDispatch(scriptFor({ holdBug: true, tests: true }), turns) })

  assert.equal(result.pass, true, result.report)
  assert.deepEqual(posted.map((entry) => entry.batch), ['ask', 'step1.gate'])
  assert.match(posted[1]!.questions[0]!.question, /^bugs-001 at src\/math.ts:6: Subtract b in sub. Fix it\?$/)
  assert.match(posted[1]!.questions[0]!.why, /^Should sub throw on a negative result\?/)
  const patchOutput = turns.filter((turn) => turn.role === 'patch' && turn.output).map((turn) => turn.output).join('\n')
  // The tool output reaches the script JSON-encoded twice, so newlines and quotes arrive escaped.
  assert.match(patchOutput, /May sub return a negative number\?(\\)+n  Answer: No, throw an error/)
  assert.match(patchOutput, /ACTION=keep reason=user_decision note=(\\)+"fix it, and keep add\(\) as it is/)
  assert.match(result.report, /## Your decisions\n\n- May sub return a negative number\? \*\*No, throw an error\*\*/)
})

test('a run without answers pauses, and resumes without asking again or repeating the reviewers', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const { channel, posted, replies } = memoryChannel({ ask: null })
  const first: Turn[] = []
  await assert.rejects(
    runLoop(repo, 'pause', dir, { channel, dispatch: scriptedDispatch(script, first) }),
    (error: unknown) => error instanceof PausedError && /memory:ask/.test(error.message),
  )
  assert.ok(!first.some((turn) => turn.role === 'patch'))

  replies.ask = '/answer recommended'
  const second: Turn[] = []
  const result = await runLoop(repo, 'pause', dir, { channel, dispatch: scriptedDispatch(script, second) })
  assert.equal(result.pass, true)
  assert.equal(posted.length, 1)
  for (const role of ['questions', 'minimize', 'rules', 'bugs', 'anti-slop']) assert.ok(!second.some((turn) => turn.role === role), `${role} ran again`)
})

test('the loop stops before any work when a model is outside the allowed list', async () => {
  const repo = fixtureRepo()
  const input = loopInput(repo, 'not-allowed')
  input.models = { ...defaultModels, step1: { ...defaultModels.step1, 'anti-slop': { provider: 'claude', model: 'claude-sonnet-5-5' } } }
  const turns: Turn[] = []
  await assert.rejects(runLoop(repo, 'not-allowed', runsDir(), { dispatch: scriptedDispatch(script, turns), input }), /outside the allowed list .*claude-sonnet-5-5/)
  assert.equal(turns.length, 0)
})

test('a critical finding that the patch agent rejects goes to Eric, and only his acceptance clears it', async () => {
  const rejecting = scriptFor({ rejectBug: true, tests: true })
  const criterion = (result: { criteria: { name: string; ok: boolean; detail: string }[] }) =>
    result.criteria.find((entry) => entry.name === 'No critical or high finding left unapplied without your OK')!

  const refused = memoryChannel()
  const first = await runLoop(fixtureRepo(), 'refused', runsDir(), { channel: refused.channel, dispatch: scriptedDispatch(rejecting, []) })
  const asked = refused.posted.find((entry) => entry.batch === 'step1.patch.rejections')
  assert.equal(asked?.questions.length, 1)
  assert.match(asked!.questions[0]!.question, /did not apply bugs-001 \(critical\)/)
  assert.match(asked!.questions[0]!.why, /callers depend on the sum/)
  assert.deepEqual([criterion(first).ok, first.pass], [false, false])

  const accepted = memoryChannel({ 'step1.patch.rejections': '/answer\nQ1: a' })
  const second = await runLoop(fixtureRepo(), 'accepted', runsDir(), { channel: accepted.channel, dispatch: scriptedDispatch(rejecting, []) })
  assert.deepEqual([criterion(second).ok, criterion(second).detail], [true, 'you accepted the rejection of bugs-001'])
})
