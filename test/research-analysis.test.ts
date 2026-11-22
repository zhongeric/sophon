import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { memoryChannel } from './support/fixture.ts'
import { notebook, researchConfig, researchInput, researchScript, runResearch, type ResearchScriptOptions } from './support/research.ts'
import { scriptedDispatch, type Script, type Turn } from './support/scripted-model.ts'

const refs = (origin: string) => execFileSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname)']).toString()
const builderTurns = (turns: Turn[]) => turns.filter((turn) => turn.role === 'builder' && turn.output === null)
const builderOutput = (turns: Turn[]) =>
  turns
    .filter((turn) => turn.role === 'builder' && turn.output !== null)
    .map((turn) => turn.output)
    .join('\n')

/** One run with the pick of hyp-001 only. `commands` replaces domain commands of the notebook config. */
async function analysisRun(runId: string, options: ResearchScriptOptions = {}, commands: Partial<typeof researchConfig.commands> = {}, script: Script = researchScript(options)) {
  const config = { checks: { smoke: 'true' }, research: { ...researchConfig, commands: { ...researchConfig.commands, ...commands } } }
  const { repo, origin, base } = notebook({ config })
  const turns: Turn[] = []
  const { channel } = memoryChannel({ pick: '/answer\nQ1: a' })
  const run = await runResearch(repo, mkdtempSync(join(tmpdir(), 'factory-research-runs-')), researchInput(base, runId), {
    channel,
    dispatch: scriptedDispatch(script, turns),
  })
  return { ...run, origin, turns }
}

test('research: a first analysis with no output goes back to the builder one time, then passes', { timeout: 300_000 }, async () => {
  const { result, deps, turns } = await analysisRun('a1', { analysisFix: true })
  assert.equal(result.status, 'ready', result.report)
  // The build, the calibration fix and the analysis fix: three turns, each with its own output key.
  assert.equal(builderTurns(turns).length, 3)
  assert.ok(deps.ledger.get('step:build.hyp-001.fix-1'))
  assert.ok(deps.ledger.get('step:build.hyp-001.analysis-fix-1'))
  // The analysis fix turn read the reason and the end of the analyze output.
  assert.match(builderOutput(turns), /analyze gives no output/)
  assert.match(builderOutput(turns), /analyze of hyp-001 in /)
  assert.match(result.report, /Analysis round 1 at [0-9a-f]{12}: FAIL, .*analyze gives no output/)
  assert.match(result.report, /Analysis round 2 at [0-9a-f]{12}: PASS/)
  // known and inject give no reads, so the fix ran the calibration again before the analysis.
  assert.equal(deps.ledger.get<{ result: { pass: boolean } }>('step:calibrate.hyp-001.3')?.result.pass, true)
})

for (const [path, again] of [['search.py', false], ['analyze.mjs', true]] as const) {
  test(`research: an analysis fix compares reads of ${path} with the changed file`, { timeout: 300_000 }, async () => {
    const reads = (command: string) => `READS=research/,analysis/hyp-001/${path} ${command}`
    const { result, deps } = await analysisRun(`fix-${path}`, { analysisFix: true }, { known: reads(researchConfig.commands.known), inject: reads(researchConfig.commands.inject) })
    assert.equal(result.status, 'ready', result.report)
    assert.equal(deps.ledger.get<{ result: boolean }>('step:recalibrate.hyp-001.analysis-fix-1')?.result, again)
    const calibration = deps.ledger.get<{ result: { head: string; pass: boolean } }>('step:calibrate.hyp-001.3')?.result
    if (again) {
      const fixed = deps.ledger.get<{ result: { head: string } }>('step:analysis.hyp-001.2')?.result
      assert.equal(calibration?.pass, true)
      assert.equal(calibration?.head, fixed?.head)
    } else {
      // The analyst changes the directory later, so only that change runs the calibration again.
      const committed = deps.ledger.get<{ result: string }>('step:commit.hyp-001.1')?.result
      assert.ok(committed)
      assert.equal(calibration?.head, committed)
    }
  })
}

for (const operation of ['remove', 'rename'] as const) {
  test(`research: an analysis fix recalibrates after it ${operation}s a declared input`, { timeout: 300_000 }, async () => {
    const options = { analysisFix: true }
    const base = researchScript(options)
    const path = 'analysis/hyp-001/model.json'
    const script: Script = (turn) => {
      const reply = base(turn)
      if (turn.role !== 'builder' || !('cell' in reply)) return reply
      const fix = turn.request.includes('Analysis round 1 of')
      const edit = fix
        ? `await tools.Read({ file_path: '/repo/${path}' })\nawait tools.Bash({ command: '${operation === 'remove' ? 'rm' : 'mv'} /repo/${path}${operation === 'rename' ? ' /repo/analysis/hyp-001/renamed.json' : ''}' })`
        : turn.request.includes('Build the analysis') ? `await tools.Write({ file_path: '/repo/${path}', content: '{}' })` : ''
      const changes = [path, ...(fix && operation === 'rename' ? ['analysis/hyp-001/renamed.json'] : [])].map((path) => ({ path, why: 'the model input' }))
      return { cell: reply.cell.replace('await tools.checkpoint(', `${edit}\nawait tools.checkpoint(`).replace('"changes":[', `"changes":[${changes.map((change) => JSON.stringify(change)).join(',')},`) }
    }
    const reads = (command: string) => `READS=${path} ${command}`
    const { result, deps } = await analysisRun(`fix-${operation}`, options, { known: reads(researchConfig.commands.known), inject: reads(researchConfig.commands.inject) }, script)
    assert.equal(result.status, 'ready', result.report)
    assert.equal(deps.ledger.get<{ result: boolean }>('step:recalibrate.hyp-001.analysis-fix-1')?.result, true)
    const analyzed = deps.ledger.get<{ result: { head: string } }>('step:analysis.hyp-001.2')?.result
    const calibrated = deps.ledger.get<{ result: { head: string; pass: boolean } }>('step:calibrate.hyp-001.3')?.result
    assert.equal(calibrated?.pass, true)
    assert.equal(calibrated?.head, analyzed?.head)
  })
}

test('research: an analysis that fails two times blocks the run before the push', { timeout: 300_000 }, async () => {
  const { result, origin, pulls, turns } = await analysisRun('a2', { noAnalysis: true })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /Analysis round 2 of hyp-001 failed: analyze gives no output\. The run did not push the branch and opened no PR\./)
  assert.match(result.report, /\(local, not pushed\)/)
  assert.equal(builderTurns(turns).length, 3)
  assert.ok(!turns.some((turn) => turn.role === 'skeptic'))
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})

test('research: after an analyst change, only the analysis runs again when the reads of known and inject are outside analysis/<id>/', { timeout: 300_000 }, async () => {
  const reads = (command: string) => `READS=research/,catalog/ ${command}`
  const { result, deps } = await analysisRun('a3', {}, { known: reads(researchConfig.commands.known), inject: reads(researchConfig.commands.inject) })
  assert.equal(result.status, 'ready', result.report)
  const committed = deps.ledger.get<{ result: string }>('step:commit.hyp-001.1')?.result
  assert.ok(committed)
  // No new calibrate step after the analyst commit, and the new analysis ran on the commit of the analyst.
  assert.equal(deps.ledger.get('step:calibrate.hyp-001.3'), undefined)
  const second = deps.ledger.get<{ result: { head: string; pass: boolean } }>('step:analysis.hyp-001.2')?.result
  assert.equal(second?.head, committed)
  assert.equal(second?.pass, true)
  assert.match(result.report, /Reproduction at [0-9a-f]{12} \(output artifact [0-9a-f]{64}\): PASS/)
})

test('research: the analysis build runs no ci commands of the notebook', { timeout: 300_000 }, async () => {
  const { repo, base } = notebook({ config: { checks: { smoke: 'true' }, ci: { broken: 'false' }, research: researchConfig } })
  const turns: Turn[] = []
  const { channel } = memoryChannel({ pick: '/answer\nQ1: a' })
  const { result } = await runResearch(repo, mkdtempSync(join(tmpdir(), 'factory-research-runs-')), researchInput(base, 'a5'), {
    channel,
    dispatch: scriptedDispatch(researchScript(), turns),
  })
  // The builder got no ci refusal, and the analysis passed. The review loop of the dossier PR keeps its ci gate.
  assert.ok(!turns.some((turn) => turn.role === 'builder' && turn.request.includes('the ci commands failed')))
  assert.match(result.report, /Analysis round \d at [0-9a-f]{12}: PASS/)
})

test('research: a reproduction without the analysis hash blocks the run before the push', { timeout: 300_000 }, async () => {
  const { result, origin, pulls } = await analysisRun('a4', {}, { reproduce: `OMIT_ANALYSIS=1 ${researchConfig.commands.reproduce}` })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /The reproduction on a clean checkout of [0-9a-f]{12} failed/)
  assert.match(result.report, /out\/hyp-001\/analysis\.txt: reproduce gave no hash/)
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})
