import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Machine, RepoConfig } from '../src/core/checks.ts'
import { freezePrereg } from '../src/core/prereg.ts'
import { analysisVerdict, analyzeCommand, calibrationVerdict, compareReproduction, needsRecalibration, preregThreshold, runDomainCommand } from '../src/core/research-commands.ts'
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
  await assert.rejects(runDomainCommand(config, own.machine, 'analyze', 'prereg/hyp-001-v1.md'), /needs the hypothesis ID/)
})

test('known and inject may give reads without a leading slash, reproduce and analyze ignore it, and a bad reads fails the run', async () => {
  const known = await run({ 'search known': ok({ recall: 1, outputs: {}, reads: ['/search/', 'data/catalog.csv'] }) }, 'known')
  assert.deepEqual(known.json?.reads, ['search/', 'data/catalog.csv'])
  assert.deepEqual((await run({ 'search inject': ok({ outputs: {}, reads: [] }) }, 'inject')).json?.reads, [])
  assert.equal((await run({ 'search inject': ok({ outputs: {} }) }, 'inject')).json?.reads, null)
  assert.equal((await run({ 'search reproduce': ok({ outputs: {}, reads: 7 }) }, 'reproduce')).json?.reads, null)
  for (const bad of ['search/', [''], ['/'], ['search/', 3], null]) {
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

test('a reproduction that gives no hash for an analysis output fails with that path in missing', async () => {
  const calibration = { 'out/known.csv': hash('a') }
  const reproduce = await run({ 'search reproduce': ok({ outputs: calibration }) }, 'reproduce')
  const result = compareReproduction({ ...calibration, 'out/hyp-001/a.csv': hash('c') }, reproduce)
  assert.equal(result.pass, false)
  assert.deepEqual(result.missing, ['out/hyp-001/a.csv'])
  if (!result.pass) assert.match(result.reason, /out\/hyp-001\/a.csv: reproduce gave no hash/)
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
