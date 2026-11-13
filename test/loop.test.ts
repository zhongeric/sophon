import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { profiles, staticFindings, triage } from '../src/core/profiles.ts'
import { PausedError, type Channel } from '../src/core/questions.ts'
import { allowedModelsFrom, defaultAllowedModels, defaultModels } from '../src/core/workflows/code-review-loop.ts'
import { resumeInput } from '../src/node/cli.ts'
import { changedFiles, diff, touchedFiles } from '../src/node/git.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { fixed, fixtureRepo, gitSource, lightFixed, loopInput, memoryChannel, runLoop, script, scriptFor } from './support/fixture.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

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
  // With a test runner, no agent hears that it has none.
  assert.ok(!turns.some((turn) => turn.request.includes('This run has no run_tests tool')))

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

test('a docs and tests only change takes the light loop: host findings, one reviewer that fixes, checks', async () => {
  const repo = fixtureRepo({ light: true })
  const turns: Turn[] = []
  const result = await runLoop(repo, 'light', runsDir(), { dispatch: scriptedDispatch(script, turns) })

  assert.equal(result.pass, true, result.report)
  assert.deepEqual([...new Set(turns.map((turn) => `${turn.role}:${turn.provider}`))], ['light:claude'])
  const show = (path: string) => execFileSync('git', ['show', `${result.branch}:${path}`], { cwd: repo }).toString()
  assert.deepEqual([show('docs/v2.md'), show('test/Vault.t.sol')], [lightFixed.docs, lightFixed.test])
  assert.match(turns.filter((turn) => turn.output).map((turn) => turn.output).join('\n'), /code refused: .*EACCES/)

  const gateLog = readFileSync(join(result.dir, 'gate-log.txt'), 'utf8')
  assert.match(gateLog, /^TRIAGE path=light reason=docs-or-tests-only profiles=solidity,solidity-support,docs\n/)
  assert.match(gateLog, /# Light \| model_family=claude \| light=claude-opus-5-5/)
  assert.match(gateLog, /FINDING host-001 \| track=rules \| severity=low \| ACTION=keep/)
  assert.match(gateLog, /FINDING host-002 \| track=rules \| severity=low \| ACTION=keep/)
  assert.match(result.report, /^# Code review loop \(light\): PASS/)
  assert.match(result.report, /Light review: commit [0-9a-f]{12}; applied: host-001 \(wrote for example\); host-002 .*; other fixes: docs\/v2.md:1/)
  assert.doesNotMatch(result.report, /## Intent/)
})

test('triage sees deleted files and the old path of a rename, so a docs change that removes code takes the full loop', async () => {
  const repo = fixtureRepo({ light: true })
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  run('rm', '-q', 'test/add.test.ts')
  run('mv', 'src/math.ts', 'docs/math.md')
  run('commit', '-q', '-m', 'remove code')

  assert.deepEqual((await changedFiles(repo, 'main', 'HEAD')).sort(), ['docs/math.md', 'docs/v2.md', 'test/Vault.t.sol'])
  const touched = (await touchedFiles(repo, 'main', 'HEAD')).sort()
  assert.deepEqual(touched, ['docs/math.md', 'docs/v2.md', 'src/math.ts', 'test/Vault.t.sol', 'test/add.test.ts'])
  const result = await triage(touched, async (path) => existsSync(join(repo, path)), false)
  assert.deepEqual([result.path, result.reason, result.files], ['full', 'not-docs-or-tests', ['src/math.ts', 'test/add.test.ts']])
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

test('a paused run without a recorded light model resumes with the default model', async () => {
  const repo = fixtureRepo()
  const dir = runsDir()
  const { channel, replies } = memoryChannel({ ask: null })
  await assert.rejects(runLoop(repo, 'old-models', dir, { channel, dispatch: scriptedDispatch(script, []) }), PausedError)
  const ledger = fileLedger(join(dir, 'old-models', 'state.json'))
  const recorded = ledger.get<ReturnType<typeof loopInput>>('input')
  assert.ok(recorded)
  const { light: _light, ...oldModels } = recorded.models
  ledger.put('input', { ...recorded, models: oldModels })
  ledger.put('git', gitSource(repo))

  replies.ask = '/answer recommended'
  const { input, source } = resumeInput(dir, 'old-models')
  assert.deepEqual(input.models.light, defaultModels.light)
  assert.deepEqual(source, gitSource(repo))
  const result = await runLoop(repo, 'old-models', dir, { channel, dispatch: scriptedDispatch(script, []), input })
  assert.equal(result.pass, true, result.report)
  assert.deepEqual(fileLedger(join(dir, 'old-models', 'state.json')).get<ReturnType<typeof loopInput>>('input')?.models.light, defaultModels.light)
})

test('host git returns raw Unicode paths in diffs and file lists', async () => {
  const repo = fixtureRepo({ light: true })
  mkdirSync(join(repo, 'café'))
  writeFileSync(join(repo, 'café/.env'), 'SECRET=value\n')
  writeFileSync(join(repo, 'docs/café.log'), 'log\n')
  writeFileSync(join(repo, 'docs/café.md'), 'e.g. a cafe\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'Unicode paths'], { cwd: repo })
  const changed = await changedFiles(repo, 'main', 'HEAD')
  const touched = await touchedFiles(repo, 'main', 'HEAD')
  for (const path of ['café/.env', 'docs/café.log', 'docs/café.md']) {
    assert.ok(changed.includes(path), JSON.stringify(changed))
    assert.ok(touched.includes(path), JSON.stringify(touched))
  }
  const findings = staticFindings(await diff(repo, 'main', 'HEAD'), changed, profiles)
  assert.ok(findings.some((finding) => finding.location === 'café/.env:1' && finding.severity === 'high'))
  assert.ok(findings.some((finding) => finding.location === 'docs/café.log:1'))
  assert.ok(findings.some((finding) => finding.location === 'docs/café.md:1' && finding.trigger.includes('docs-latin')))
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

test('ALLOWED_MODELS replaces the allowed list', async () => {
  assert.deepEqual(allowedModelsFrom(undefined), defaultAllowedModels)
  assert.deepEqual(allowedModelsFrom(' , '), defaultAllowedModels)
  const repo = fixtureRepo()
  const input = loopInput(repo, 'allowed-setting')
  input.models = { ...defaultModels, step1: { ...defaultModels.step1, 'anti-slop': { provider: 'claude', model: 'claude-sonnet-5-5' } } }
  input.allowedModels = allowedModelsFrom('claude-sonnet-5-5, claude-opus-5-5')
  const turns: Turn[] = []
  await assert.rejects(
    runLoop(repo, 'allowed-setting', runsDir(), { dispatch: scriptedDispatch(script, turns), input }),
    /outside the allowed list \(claude-sonnet-5-5, claude-opus-5-5\): gpt-6\.1-sol, claude-fable-5-2$/,
  )
  assert.equal(turns.length, 0)
})

test("a critical finding that the patch agent rejects goes to the user, and only the user's acceptance clears it", async () => {
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

/** Lines `export const <name><i> = <i>` for i from 0, with some values replaced. */
const constants = (name: string, count: number, replace: Record<number, number> = {}) =>
  Array.from({ length: count }, (_, i) => `export const ${name}${i} = ${replace[i] ?? i}\n`).join('')

/** A repository whose feature branch adds about 800 lines in two directories, so that two bugs reviewers split it. */
function largeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'factory-large-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  const write = (path: string, content: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  write('.agent-factory.json', JSON.stringify({ stack: 'TypeScript', checks: { smoke: 'node -e "process.exit(0)"' } }))
  write('src/alpha/a.ts', constants('a', 1))
  write('src/beta/b.ts', constants('b', 1))
  write('src/util.ts', 'export const util = 1\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'base')
  run('checkout', '-q', '-b', 'feature')
  write('src/alpha/a.ts', constants('a', 400))
  write('src/beta/b.ts', constants('b', 400))
  write('src/util.ts', 'export const util = 2\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'add constants')
  return repo
}

const largeFixed = {
  alpha: constants('a', 400, { 2: 22 }),
  alphaFinal: constants('a', 400, { 2: 22, 3: 33 }),
  beta: constants('b', 400, { 2: 22, 4: 44 }),
  util: 'export const util = 3\n',
}

/**
 * The agents of the large change. Each bugs reviewer reports a bug in its own directory. The patch agent of the
 * beta findings needs a file of the alpha agent, so it defers that finding to the agent that runs after them.
 */
const largeScript: Script = ({ role, output, request }) => {
  if (output !== null) return { text: 'done' }
  const findings = (list: unknown[]) => `await tools.submit_findings({ findings: ${JSON.stringify(list)} })`
  const at = (location: string, evidence: string, severity: string) => ({ location, evidence, severity, title: 'Fix the value', trigger: 'import', impact: 'wrong value', recommendation: 'fix it' })
  const write = (path: string, content: string) => `await tools.Write({ file_path: '/repo/${path}', content: ${JSON.stringify(content)} })`
  const log = (applied: string[], deferred: { id: string; reason: string }[] = []) =>
    `await tools.submit_patch_log({ applied: ${JSON.stringify(applied.map((id) => ({ id, change: 'fixed' })))}, skipped: [], deferred: ${JSON.stringify(deferred)} })`
  switch (role) {
    case 'bugs':
      if (request.includes('src/alpha/a.ts')) return { cell: findings([at('src/alpha/a.ts:3', 'export const a2 = 2', 'high')]) }
      return { cell: findings([at('src/beta/b.ts:3', 'export const b2 = 2', 'medium')]) }
    case 'anti-slop':
      return { cell: findings([at('src/beta/b.ts:5', 'export const b4 = 4', 'info'), at('src/util.ts:1', 'export const util = 2', 'info')]) }
    case 'questions':
      return { cell: 'await tools.submit_questions({ questions: [] })' }
    case 'intent':
      return { cell: `await tools.submit_verdict({ satisfied: true, gaps: [], summary: 'the constants are correct' })` }
    case 'patch':
      if (request.includes('Apply the deferred findings'))
        return { cell: [write('src/alpha/a.ts', largeFixed.alphaFinal), `await tools.submit_patch_log({ applied: [{ id: 'bugs-002', change: 'fixed a3' }], skipped: [] })`].join('\n') }
      if (request.includes('bugs-001')) return { cell: [write('src/alpha/a.ts', largeFixed.alpha), log(['bugs-001'])].join('\n') }
      if (request.includes('bugs-002'))
        return {
          cell: [
            write('src/beta/b.ts', largeFixed.beta),
            `try { ${write('src/alpha/a.ts', 'x')}; text('OTHER AGENT FILE WRITTEN') } catch (error) { text('refused: ' + error) }`,
            log(['anti-001'], [{ id: 'bugs-002', reason: 'b2 also needs a3 in src/alpha/a.ts' }]),
          ].join('\n'),
        }
      return { cell: [write('src/util.ts', largeFixed.util), log(['anti-002'])].join('\n') }
    default:
      return { cell: findings([]) }
  }
}

test('a large change splits the bugs review across reviewers, and patch agents work on separate files at the same time', async () => {
  const repo = largeRepo()
  const turns: Turn[] = []
  const result = await runLoop(repo, 'large', runsDir(), { dispatch: scriptedDispatch(largeScript, turns) })
  assert.equal(result.pass, true, result.report)

  // Two bugs reviewers, each with its share of the diff, and their findings in one list.
  const first = (role: string) => turns.filter((turn) => turn.role === role && turn.output === null)
  const bugs = first('bugs')
  assert.equal(bugs.length, 2)
  assert.ok(bugs.some((turn) => /Your files, 2 of the 3 files of the change: src\/alpha\/a\.ts, src\/util\.ts\./.test(turn.request)))
  assert.ok(bugs.some((turn) => /Your files, 1 of the 3 files of the change: src\/beta\/b\.ts\./.test(turn.request)))
  assert.match(result.report, /Step 1 findings: host=0, minimize=0, rules=0, bugs=2, anti-slop=2/)
  const gateLog = readFileSync(join(result.dir, 'gate-log.txt'), 'utf8')
  assert.match(gateLog, /FINDING bugs-001 \| track=bugs \| severity=high/)
  assert.match(gateLog, /FINDING bugs-002 \| track=bugs \| severity=medium/)

  // Three patch agents at the same time: alpha, beta with its info finding, and the other info finding. Then one for the deferred finding.
  assert.equal(first('patch').length, 4)
  assert.match(turns.filter((turn) => turn.role === 'patch' && turn.output).map((turn) => turn.output).join('\n'), /refused: .*EACCES/)
  assert.match(result.report, /Step 1 patch: commit [0-9a-f]{12} \(3 patch agents at the same time, then one for bugs-002\); applied: bugs-001 \(fixed\); anti-001 \(fixed\); anti-002 \(fixed\); bugs-002 \(fixed a3\)/)
  const show = (path: string) => execFileSync('git', ['show', `${result.branch}:${path}`], { cwd: repo }).toString()
  assert.deepEqual([show('src/alpha/a.ts'), show('src/beta/b.ts'), show('src/util.ts')], [largeFixed.alphaFinal, largeFixed.beta, largeFixed.util])
  assert.deepEqual(fileLedger(join(result.dir, 'state.json')).get('groups:step1.patch'), [
    { ids: ['bugs-001'], files: ['src/alpha/a.ts'] },
    { ids: ['bugs-002', 'anti-001'], files: ['src/beta/b.ts'] },
    { ids: ['anti-002'], files: ['src/util.ts'] },
  ])
})
