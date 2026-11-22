import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Machine, RepoConfig } from '../src/core/checks.ts'
import { freezePrereg } from '../src/core/prereg.ts'
import {
  analysisVerdict,
  analyzeCommand,
  calibrationVerdict,
  compareReproduction,
  needsRecalibration,
  parseUnitOutput,
  preregThreshold,
  runDomainCommand,
  runFetch,
  runMerge,
  runPlan,
  unitCommand,
} from '../src/core/research-commands.ts'
import type { ResearchConfig } from '../src/core/research.ts'

const hash = (char: string) => char.repeat(64)
const research: ResearchConfig = {
  egress: ['archive.example.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: ['literature'], skeptic: ['systematics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Known set'],
  commands: { known: 'search known {prereg}', inject: 'search inject {prereg}', evaluate: 'search evaluate {prereg}', reproduce: 'search reproduce {prereg}' },
}
const config: RepoConfig = { stack: 'Python', checks: {}, research, env: ['ETH_RPC_URL', 'GITHUB_TOKEN'], timeout_ms: 5_000 }

type Reply = { exit_code: number | null; output: string }

/** A machine that gives the reply of the first matching command prefix, and records each call. */
function fakeMachine(replies: Record<string, Reply>) {
  const calls: { command: string; env: string[]; timeoutMs: number }[] = []
  const machine: Machine = {
    async run(command, { env, timeoutMs }) {
      calls.push({ command, env, timeoutMs })
      const key = Object.keys(replies).find((prefix) => command.startsWith(prefix))
      return key === undefined ? { exit_code: 127, output: 'not found' } : replies[key]!
    },
  }
  return { machine, calls }
}

const ok = (json: unknown, before = 'working\n'): Reply => ({ exit_code: 0, output: `${before}${JSON.stringify(json)}\n\n` })
const run = (replies: Record<string, Reply>, name: 'known' | 'inject' | 'reproduce', extra: Partial<RepoConfig> = {}) =>
  runDomainCommand({ ...config, ...extra }, fakeMachine(replies).machine, name, 'prereg/hyp-001-v1.md')

async function calibrate(known: Reply, inject: Reply, threshold: number) {
  const { machine } = fakeMachine({ 'search known': known, 'search inject': inject })
  const runs = [await runDomainCommand(config, machine, 'known', 'prereg/hyp-001-v1.md'), await runDomainCommand(config, machine, 'inject', 'prereg/hyp-001-v1.md')]
  return calibrationVerdict(runs[0]!, runs[1]!, threshold)
}

const injectOk = ok({ outputs: { 'out/inject.csv': hash('b') } })

test('the command gets the quoted prereg path, the check environment without host secrets, and the config timeout', async () => {
  const { machine, calls } = fakeMachine({ 'search known': ok({ recall: 1, outputs: {} }) })
  const result = await runDomainCommand({ ...config, research: { ...research, commands: { ...research.commands, known: 'search known {prereg} {prereg}' } } }, machine, 'known', "prereg/it's.md")
  assert.equal(result.command, `search known 'prereg/it'\\''s.md' 'prereg/it'\\''s.md'`)
  assert.equal(calls[0]?.command, result.command)
  assert.ok(calls[0]?.env.includes('PATH') && calls[0].env.includes('ETH_RPC_URL'))
  assert.ok(!calls[0]?.env.includes('GITHUB_TOKEN'))
  assert.equal(calls[0]?.timeoutMs, 5_000)
  assert.equal(result.problem, null)
  assert.deepEqual(result.json, { recall: 1, outputs: {}, reads: null })
})

test('analyze without a config command runs the entry point of the hypothesis with the quoted prereg and the analyze timeout', async () => {
  const { machine, calls } = fakeMachine({ 'make setup': { exit_code: 0, output: '' }, 'python': ok({ outputs: { 'out/hyp-001/a.csv': hash('c') } }) })
  const withTimeouts = { ...config, setup: 'make setup', research: { ...research, timeouts: { analyze: 900_000 } } }
  const result = await runDomainCommand(withTimeouts, machine, 'analyze', "prereg/it's.md", 'hyp-001')
  assert.equal(analyzeCommand(research, 'hyp-001'), "python 'analysis/hyp-001/analyze.py' {prereg}")
  assert.equal(result.command, "python 'analysis/hyp-001/analyze.py' 'prereg/it'\\''s.md'")
  assert.deepEqual(calls.map(({ command, timeoutMs }) => [command, timeoutMs]), [['make setup', 5_000], [result.command, 900_000]])
  assert.deepEqual(result.json, { recall: null, outputs: { 'out/hyp-001/a.csv': hash('c') }, reads: null })

  const configured = { ...research, commands: { ...research.commands, analyze: 'search analyze {prereg}' } }
  assert.equal(analyzeCommand(configured, 'hyp-001'), 'search analyze {prereg}')
  const own = fakeMachine({ 'search analyze': ok({ outputs: {} }) })
  assert.equal((await runDomainCommand({ ...config, research: configured }, own.machine, 'analyze', 'prereg/hyp-001-v1.md', 'hyp-001')).command, "search analyze 'prereg/hyp-001-v1.md'")
  assert.equal(own.calls[0]?.timeoutMs, 5_000)
})

test('known and inject may give reads in the form of git paths, reproduce and analyze ignore it, and a bad reads fails the run', async () => {
  const given = ['/search/', 'data/catalog.csv', './analysis/hyp-001/', 'analysis/./hyp-001/', 'search/../analysis/', 'search//known.py']
  const known = await run({ 'search known': ok({ recall: 1, outputs: {}, reads: given }) }, 'known')
  assert.deepEqual(known.json?.reads, ['search/', 'data/catalog.csv', 'analysis/hyp-001/', 'analysis/hyp-001/', 'analysis/', 'search/known.py'])
  assert.deepEqual((await run({ 'search inject': ok({ outputs: {}, reads: [] }) }, 'inject')).json?.reads, [])
  assert.equal((await run({ 'search inject': ok({ outputs: {} }) }, 'inject')).json?.reads, null)
  assert.equal((await run({ 'search reproduce': ok({ outputs: {}, reads: 7 }) }, 'reproduce')).json?.reads, null)
  for (const bad of ['search/', [''], ['/'], ['./'], ['../x'], ['a/../..'], ['search/', 3], null]) {
    const failed = await run({ 'search inject': ok({ outputs: {}, reads: bad }) }, 'inject')
    assert.equal(failed.json, null)
    assert.match(failed.problem ?? '', /the last line of inject: reads must be a list of non-empty path prefixes/)
  }
})

test('a domain command takes its own timeout from research.timeouts, and the setup and other commands keep the config timeout', async () => {
  const { machine, calls } = fakeMachine({ 'make setup': { exit_code: 0, output: '' }, 'search': ok({ recall: 1, outputs: {} }) })
  const withTimeouts = { ...config, setup: 'make setup', research: { ...research, timeouts: { known: 7_200_000 } } }
  for (const name of ['known', 'inject'] as const) await runDomainCommand(withTimeouts, machine, name, 'prereg/hyp-001-v1.md')
  assert.deepEqual(calls.map(({ command, timeoutMs }) => [command.split(' ').slice(0, 2).join(' '), timeoutMs]), [['make setup', 5_000], ['search known', 7_200_000], ['search inject', 5_000]])

  const fallback = fakeMachine({ 'search known': ok({ recall: 1, outputs: {} }) })
  const { timeout_ms: _, ...withoutTimeout } = config
  await runDomainCommand({ ...withoutTimeout, research: { ...research, timeouts: { inject: 1_000 } } }, fallback.machine, 'known', 'prereg/hyp-001-v1.md')
  assert.equal(fallback.calls[0]?.timeoutMs, 30 * 60_000)
})

test('the setup runs one time for each machine, and a failed setup fails the command', async () => {
  const { machine, calls } = fakeMachine({ 'make setup': { exit_code: 0, output: '' }, 'search': ok({ recall: 1, outputs: {} }) })
  const withSetup = { ...config, setup: 'make setup' }
  for (const name of ['known', 'inject', 'reproduce'] as const) await runDomainCommand(withSetup, machine, name, 'prereg/hyp-001-v1.md')
  assert.deepEqual(calls.map((call) => call.command.split(' ')[0]), ['make', 'search', 'search', 'search'])

  const failed = await run({ 'make setup': { exit_code: 2, output: 'no compiler' } }, 'known', { setup: 'make setup' })
  assert.equal(failed.exit_code, 2)
  assert.equal(failed.output, 'no compiler')
  assert.match(failed.problem ?? '', /the setup make setup exited with code 2/)
})

test('a known recall equal to the threshold passes, with the outputs of known and inject', async () => {
  const verdict = await calibrate(ok({ recall: 0.8, outputs: { 'out/known.csv': hash('A') } }), injectOk, 0.8)
  assert.deepEqual(verdict, { pass: true, recall: 0.8, threshold: 0.8, outputs: { 'out/known.csv': hash('a'), 'out/inject.csv': hash('b') } })
})

test('a known recall below the threshold fails with the recall, the threshold and the tail', async () => {
  const verdict = await calibrate(ok({ recall: 0.79, outputs: {} }, 'missed object M31\n'), injectOk, 0.8)
  assert.equal(verdict.pass, false)
  if (verdict.pass) return
  assert.equal(verdict.recall, 0.79)
  assert.match(verdict.reason, /0\.79 is below the threshold 0\.8/)
  assert.match(verdict.tail, /missed object M31/)
})

test('a calibration without outputs fails, so that the reproduction compares at least one hash', async () => {
  const verdict = await calibrate(ok({ recall: 1, outputs: {} }), ok({ outputs: {} }), 0.5)
  assert.equal(verdict.pass, false)
  if (verdict.pass) return
  assert.match(verdict.reason, /known and inject give no outputs/)
})

test('a non-zero exit, a timeout and an output without a JSON last line each fail with the tail', async () => {
  const known = ok({ recall: 1, outputs: {} })
  const cases: [Reply, Reply, RegExp][] = [
    [known, { exit_code: 1, output: 'Traceback: inject broke' }, /inject exited with code 1/],
    [{ exit_code: null, output: 'slow known\n[host] killed after 5000 ms' }, injectOk, /known did not finish/],
    [{ exit_code: 0, output: 'recall is 0.9\n' }, injectOk, /the last line of known is not JSON/],
    [{ exit_code: 0, output: '[1, 2]' }, injectOk, /the last line of known is not a JSON object/],
    [ok({ recall: 1.5, outputs: {} }), injectOk, /recall must be a number from 0 to 1/],
    [known, ok({ outputs: { 'out/a.csv': 'abc' } }), /the hash of out\/a.csv is not SHA-256 hex/],
  ]
  for (const [knownReply, injectReply, reason] of cases) {
    const verdict = await calibrate(knownReply, injectReply, 0.5)
    assert.equal(verdict.pass, false)
    if (verdict.pass) continue
    assert.match(verdict.reason, reason)
    const failedOutput = reason.source.includes('inject') || reason.source.includes('SHA') ? injectReply.output : knownReply.output
    assert.ok(verdict.tail.includes(failedOutput.trim()), verdict.tail)
  }
})

test('the tail keeps the end of a long output', async () => {
  const verdict = await calibrate({ exit_code: 1, output: `${'x'.repeat(10_000)}the end` }, injectOk, 0.5)
  assert.equal(verdict.pass, false)
  if (verdict.pass) return
  assert.ok(verdict.tail.endsWith('the end'))
  assert.ok(verdict.tail.length < 4_200)
})

test('the reproduction lists each hash mismatch and each missing path', async () => {
  const expected = { 'out/a.csv': hash('a'), 'out/b.csv': hash('b'), 'out/c.csv': hash('c') }
  const reproduce = await run({ 'search reproduce': ok({ outputs: { 'out/a.csv': hash('a'), 'out/b.csv': hash('e'), 'out/extra.csv': hash('f') } }) }, 'reproduce')
  const result = compareReproduction(expected, reproduce)
  assert.equal(result.pass, false)
  assert.deepEqual(result.mismatches, [{ path: 'out/b.csv', expected: hash('b'), actual: hash('e') }])
  assert.deepEqual(result.missing, ['out/c.csv'])
  if (!result.pass) assert.match(result.reason, /out\/b.csv: expected b+, reproduce gave e+\nout\/c.csv: reproduce gave no hash/)

  assert.equal(compareReproduction({ 'out/a.csv': hash('a') }, reproduce).pass, true)
})

test('the reproduction fails on a non-zero exit or no valid JSON', async () => {
  const failures: [Reply, RegExp][] = [
    [{ exit_code: 3, output: 'disk full' }, /reproduce exited with code 3/],
    [{ exit_code: 0, output: 'done' }, /the last line of reproduce is not JSON/],
  ]
  for (const [reply, reason] of failures) {
    const result = compareReproduction({}, await run({ 'search reproduce': reply }, 'reproduce'))
    assert.equal(result.pass, false)
    if (result.pass) continue
    assert.match(result.reason, reason)
    assert.match(result.tail, new RegExp(reply.output))
  }
})

const analyze = (reply: Reply) => runDomainCommand(config, fakeMachine({ python: reply }).machine, 'analyze', 'prereg/hyp-001-v1.md', 'hyp-001')

test('an analysis with outputs passes, and a same hash as a calibration output is no conflict', async () => {
  const outputs = { 'out/known.csv': hash('a'), 'out/hyp-001/a.csv': hash('c') }
  assert.deepEqual(analysisVerdict(await analyze(ok({ outputs })), { 'out/known.csv': hash('a') }), { pass: true, outputs })
})

test('a failed analyze, no output and a conflict with a calibration hash each fail the analysis with the tail', async () => {
  const cases: [Reply, RegExp][] = [
    [{ exit_code: 1, output: 'Traceback: analyze broke' }, /analyze exited with code 1/],
    [{ exit_code: null, output: 'slow analyze\n[host] killed after 5000 ms' }, /analyze did not finish/],
    [{ exit_code: 0, output: 'table written\n' }, /the last line of analyze is not JSON/],
    [ok({ outputs: {} }, 'nothing to write\n'), /analyze gives no output/],
    [ok({ outputs: { 'out/known.csv': hash('e') } }, 'rewrote known\n'), /different hashes for out\/known.csv/],
  ]
  for (const [reply, reason] of cases) {
    const verdict = analysisVerdict(await analyze(reply), { 'out/known.csv': hash('a') })
    assert.equal(verdict.pass, false)
    if (verdict.pass) continue
    assert.match(verdict.reason, reason)
    assert.ok(verdict.tail.includes(reply.output.trim().split('\n')[0]!), verdict.tail)
  }
})

test('a calibration runs again when a reads list is missing or a prefix matches the changed files', () => {
  const dir = ['analysis/hyp-001/']
  assert.equal(needsRecalibration(null, ['search/'], dir), true)
  assert.equal(needsRecalibration(['search/'], null, dir), true)
  assert.equal(needsRecalibration(['search/', 'data/'], ['search/inject.py', 'analysis/hyp-002/'], dir), false)
  assert.equal(needsRecalibration([], [], dir), false)
  assert.equal(needsRecalibration(['analysis/'], ['search/'], dir), true)
  assert.equal(needsRecalibration(['search/'], ['analysis/hyp-001/x.py'], dir), true)
  assert.equal(needsRecalibration(['search/'], [], ['analysis/hyp-001/a.py', 'search/known.py']), true)
  assert.equal(needsRecalibration(['search/'], [], ['analysis/hyp-001/a.py']), false)
})

test('the threshold comes from the frozen prereg markdown', async () => {
  const frozen = await freezePrereg({ hypothesis: 'hyp-001', sections: [{ name: 'Method', text: 'Known recall: 0.1 is too low.' }], known_recall: 0.85 })
  assert.equal(preregThreshold(frozen.markdown), 0.85)
  assert.throws(() => preregThreshold('# Prereg hyp-001 v1\n'), /no line "Known recall: <n>"/)
  assert.throws(() => preregThreshold('Known recall: high\n'), /no line "Known recall: <n>"/)
})

const fanOutResearch: ResearchConfig = {
  ...research,
  commands: { ...research.commands, plan: 'nb plan {prereg}', fetch: 'nb fetch {prereg} {target}', unit: 'nb unit {prereg} {unit}', merge: 'nb merge {prereg} {units}' },
}
const fanOutConfig: RepoConfig = { ...config, research: fanOutResearch }
const prereg = 'prereg/hyp-001-v1.md'
const plan = (reply: Reply) => runPlan(fanOutConfig, fakeMachine({ 'nb plan': reply }).machine, prereg)
const fetch = (reply: Reply) => runFetch(fanOutConfig, fakeMachine({ 'nb fetch': reply }).machine, prereg, 'T-1')
const merge = (reply: Reply) => runMerge(fanOutConfig, fakeMachine({ 'nb merge': reply }).machine, prereg, '.agent-factory/units')

test('plan gets the quoted prereg and gives its targets and units, and zero units is a valid plan', async () => {
  const { machine, calls } = fakeMachine({ 'nb plan': ok({ targets: ['T-1', "T'2"], units: [{ id: 'inj_01', targets: ['T-1'], expected_seconds: 300 }, { id: 'inj-02', targets: [], expected_seconds: 0.5 }] }) })
  const result = await runPlan(fanOutConfig, machine, "prereg/it's.md")
  assert.equal(result.command, `nb plan 'prereg/it'\\''s.md'`)
  assert.deepEqual(calls.map(({ command, timeoutMs }) => [command, timeoutMs]), [[result.command, 5_000]])
  assert.deepEqual(result.json, { targets: ['T-1', "T'2"], units: [{ id: 'inj_01', targets: ['T-1'], expected_seconds: 300 }, { id: 'inj-02', targets: [], expected_seconds: 0.5 }] })
  assert.equal(result.problem, null)
  assert.deepEqual((await plan(ok({ targets: [], units: [] }))).json, { targets: [], units: [] })
})

test('a bad plan fails with the problem and the tail', async () => {
  const unit = (patch: Record<string, unknown>) => ({ id: 'u1', targets: ['T-1'], expected_seconds: 60, ...patch })
  const cases: [Reply, RegExp][] = [
    [{ exit_code: 0, output: 'planning\n' }, /the last line of plan is not JSON/],
    [{ exit_code: 2, output: 'Traceback: plan broke' }, /plan exited with code 2/],
    [ok({ targets: 'T-1', units: [] }), /targets must be a list of non-empty strings/],
    [ok({ targets: ['T-1', 'T-2', 'T-1'], units: [] }), /targets repeats T-1/],
    [ok({ targets: ['T-1'] }), /units must be a list/],
    [ok({ targets: ['T-1'], units: [unit({}), 'u2'] }), /units\[1\] must be an object/],
    [ok({ targets: ['T-1'], units: [unit({}), unit({ expected_seconds: 5 })] }), /units\[1\]\.id repeats the unit ID u1/],
    [ok({ targets: ['T-1'], units: [unit({ targets: ['T-1', 'T-9'] })] }), /units\[0\]\.targets has T-9, which is not in targets/],
    [ok({ targets: ['T-1'], units: [unit({ targets: 'T-1' })] }), /units\[0\]\.targets must be a list of non-empty strings/],
    [ok({ targets: ['T-1 ', ' T-2'], units: [] }), /targets has names with spaces at the start or the end: "T-1 ", " T-2"/],
    [ok({ targets: ['T-1'], units: [unit({ targets: ['T-1 '] })] }), /units\[0\]\.targets has names with spaces/],
  ]
  for (const id of ['', 'a/b', '../x', 'a.b', 'a b', 'x'.repeat(65), 7]) cases.push([ok({ targets: ['T-1'], units: [unit({ id })] }), /units\[0\]\.id must match/])
  for (const seconds of [0, -1, '60', null]) cases.push([ok({ targets: ['T-1'], units: [unit({ expected_seconds: seconds })] }), /units\[0\]\.expected_seconds must be a finite positive number/])
  cases.push([{ exit_code: 0, output: '{"targets": ["T-1"], "units": [{"id": "u1", "targets": [], "expected_seconds": 1e400}]}' }, /expected_seconds must be a finite positive number/])
  for (const [reply, reason] of cases) {
    const result = await plan(reply)
    assert.equal(result.json, null, reason.source)
    if (result.problem === null) continue
    assert.match(result.problem, reason)
    assert.ok(result.tail.startsWith(`--- plan: nb plan '${prereg}' (exit code ${reply.exit_code})\n`), result.tail)
    assert.ok(result.tail.includes(reply.output.trim()), result.tail)
  }
})

test('fetch gets the quoted target and gives its data files, each at a relative path', async () => {
  const { machine, calls } = fakeMachine({ 'nb fetch': ok({ outputs: { 'data/T-1/light.fits': hash('A') } }) })
  const result = await runFetch(fanOutConfig, machine, prereg, "T'1 && rm -rf /")
  assert.equal(result.command, `nb fetch '${prereg}' 'T'\\''1 && rm -rf /'`)
  assert.equal(calls[0]?.command, result.command)
  assert.deepEqual(result.json, { outputs: { 'data/T-1/light.fits': hash('a') } })
  assert.deepEqual((await fetch(ok({ outputs: {} }))).json, { outputs: {} })

  const cases: [Reply, RegExp][] = [
    [{ exit_code: 1, output: 'HTTP 503' }, /fetch exited with code 1/],
    [{ exit_code: null, output: 'slow archive' }, /fetch did not finish/],
    [ok([]), /the last line of fetch is not a JSON object/],
    [ok({}), /outputs must be an object of path to SHA-256 hex/],
    [ok({ outputs: { 'data/a.fits': 'abc' } }), /the hash of data\/a.fits is not SHA-256 hex/],
  ]
  for (const path of ['/data/a.fits', '../a.fits', 'data/../../a.fits', 'data//a.fits', './a.fits', 'data\\a.fits'])
    cases.push([ok({ outputs: { [path]: hash('a') } }), /must be relative, with \/ and without empty, \. or \.\. segments/])
  for (const [reply, reason] of cases) {
    const result = await fetch(reply)
    assert.equal(result.json, null, reason.source)
    if (result.problem === null) continue
    assert.match(result.problem, reason)
    assert.ok(result.tail.includes(reply.output.trim()), result.tail)
  }
})

test('the unit command has the quoted prereg and unit ID without the setup, and its last line gives the unit files', () => {
  assert.equal(unitCommand(fanOutConfig, prereg, 'inj_01'), `nb unit '${prereg}' 'inj_01'`)
  assert.equal(unitCommand({ ...fanOutConfig, setup: 'make setup # deps' }, prereg, 'inj_01'), `nb unit '${prereg}' 'inj_01'`)
  assert.throws(() => unitCommand(config, prereg, 'inj_01'), /has no unit command/)

  assert.deepEqual(parseUnitOutput(`injected 3\n${JSON.stringify({ outputs: { 'out/units/inj_01.csv': hash('C') } })}\n`), { json: { outputs: { 'out/units/inj_01.csv': hash('c') } }, problem: null })
  assert.deepEqual(parseUnitOutput(''), { json: null, problem: 'unit printed nothing, but its last line must be a JSON object' })
  assert.deepEqual(parseUnitOutput('done'), { json: null, problem: 'the last line of unit is not JSON' })
  assert.match(parseUnitOutput(JSON.stringify({ outputs: { '../x.csv': hash('c') } })).problem ?? '', /the last line of unit: the output path \.\.\/x\.csv must be relative/)
})

const merged = {
  known: { recall: 0.9, outputs: { 'out/known.csv': hash('a') }, reads: ['search/'] },
  inject: { outputs: { 'out/inject.csv': hash('b') }, reads: ['search/', 'data/'] },
}

test('merge gets the quoted units directory, and its last line splits into a known run and an inject run for calibrationVerdict', async () => {
  const { machine, calls } = fakeMachine({ 'nb merge': ok(merged, 'merged 45 units\n') })
  const { known, inject } = await runMerge(fanOutConfig, machine, prereg, "units/it's")
  const command = `nb merge '${prereg}' 'units/it'\\''s'`
  assert.equal(calls[0]?.command, command)
  assert.deepEqual(known, { name: 'known', command, exit_code: 0, output: `merged 45 units\n${JSON.stringify(merged)}\n\n`, json: merged.known, problem: null })
  assert.deepEqual(inject, { ...known, name: 'inject', json: { recall: null, ...merged.inject } })
  assert.deepEqual(calibrationVerdict(known, inject, 0.8), { pass: true, recall: 0.9, threshold: 0.8, outputs: { 'out/known.csv': hash('a'), 'out/inject.csv': hash('b') } })
  assert.equal(needsRecalibration(known.json?.reads ?? null, inject.json?.reads ?? null, ['analysis/hyp-001/']), false)

  const withoutReads = await merge(ok({ known: { recall: 1, outputs: {} }, inject: { outputs: {} } }))
  assert.equal(withoutReads.known.json?.reads, null)
  assert.equal(withoutReads.inject.json?.reads, null)
})

test('a failed merge or a bad merge line fails both runs with the merge problem', async () => {
  const cases: [Reply, RegExp][] = [
    [{ exit_code: 1, output: 'Traceback: merge broke' }, /^merge exited with code 1$/],
    [{ exit_code: null, output: 'slow merge' }, /^merge did not finish/],
    [{ exit_code: 0, output: 'merged\n' }, /^the last line of merge is not JSON$/],
    [ok({ known: merged.known }), /^the last line of merge: inject must be an object$/],
    [ok({ ...merged, known: { ...merged.known, recall: 2 } }), /^the last line of merge: in known, recall must be a number from 0 to 1$/],
    [ok({ ...merged, inject: { outputs: { 'out/a.csv': 'abc' } } }), /^the last line of merge: in inject, the hash of out\/a.csv is not SHA-256 hex$/],
  ]
  for (const [reply, reason] of cases) {
    const { known, inject } = await merge(reply)
    for (const run of [known, inject]) {
      assert.equal(run.json, null)
      assert.match(run.problem ?? '', reason)
      assert.equal(run.output, reply.output)
      assert.equal(run.exit_code, reply.exit_code)
    }
    const verdict = calibrationVerdict(known, inject, 0.5)
    assert.equal(verdict.pass, false)
    if (!verdict.pass) assert.ok(verdict.tail.includes(reply.output.trim()), verdict.tail)
  }
})

test('plan, fetch and merge take their own timeouts from research.timeouts, and the setup runs one time for each machine', async () => {
  const replies = { 'make setup': { exit_code: 0, output: '' }, 'nb plan': ok({ targets: [], units: [] }), 'nb fetch': ok({ outputs: {} }), 'nb merge': ok(merged), 'search known': ok({ recall: 1, outputs: {} }) }
  const { machine, calls } = fakeMachine(replies)
  const timed = { ...fanOutConfig, setup: 'make setup', research: { ...fanOutResearch, timeouts: { plan: 60_000, fetch: 600_000, merge: 900_000, unit: 1_000 } } }
  await runPlan(timed, machine, prereg)
  await runFetch(timed, machine, prereg, 'T-1')
  await runMerge(timed, machine, prereg, 'units')
  await runDomainCommand(timed, machine, 'known', prereg)
  assert.deepEqual(calls.map(({ command, timeoutMs }) => [command.split(' ').slice(0, 2).join(' '), timeoutMs]), [
    ['make setup', 5_000],
    ['nb plan', 60_000],
    ['nb fetch', 600_000],
    ['nb merge', 900_000],
    ['search known', 5_000],
  ])

  const other = fakeMachine(replies)
  await runFetch({ ...fanOutConfig, research: { ...fanOutResearch, timeouts: { plan: 60_000 } } }, other.machine, prereg, 'T-1')
  assert.equal(other.calls[0]?.timeoutMs, 5_000)
  const failed = await runPlan({ ...fanOutConfig, setup: 'make setup' }, fakeMachine({ 'make setup': { exit_code: 2, output: 'no compiler' } }).machine, prereg)
  assert.match(failed.problem ?? '', /the setup make setup exited with code 2/)
  await assert.rejects(runPlan(config, other.machine, prereg), /has no plan command/)
})
