import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { worktreePath } from '../src/node/git.ts'
import { memoryChannel } from './support/fixture.ts'
import { notebook, researchInput, researchScript, runResearch, type ResearchScriptOptions } from './support/research.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-research-runs-'))
const refs = (origin: string) => execFileSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname)']).toString()
const outputs = (turns: Turn[], role: string) =>
  turns
    .filter((turn) => turn.role === role && turn.output !== null)
    .map((turn) => turn.output)
    .join('\n')
const firstTurns = (turns: Turn[], role: string) => turns.filter((turn) => turn.role === role && turn.output === null)

/** One run on a notebook with the pick of hyp-001 only. `replies` adds channel replies. */
async function dossierRun(runId: string, options: ResearchScriptOptions = {}, replies: Record<string, string> = {}) {
  const { repo, origin, base } = notebook()
  const runs = runsDir()
  const turns: Turn[] = []
  const channel = memoryChannel({ pick: '/answer\nQ1: a', ...replies })
  const input = researchInput(base, runId)
  const run = await runResearch(repo, runs, input, { channel: channel.channel, dispatch: scriptedDispatch(researchScript(options), turns) })
  return { ...run, repo, origin, runs, input, turns, channel }
}

test('research: build, calibration with a fix round, vet, dossier, reproduction, push, PR and review', { timeout: 300_000 }, async () => {
  const run = await dossierRun('d1')
  const { result, deps, turns, origin, pulls } = run
  assert.equal(result.status, 'ready', result.report)
  const branch = 'factory/research-d1'

  // The first calibration failed (recall 0.5, threshold 0.9). The fix turn of the builder read the reason and the end of the output.
  assert.equal(firstTurns(turns, 'builder').length, 2)
  const built = outputs(turns, 'builder')
  assert.match(built, /0\.5/)
  assert.match(built, /known of hyp-001 in /)
  // The analyst cannot write outside analysis/hyp-001/.
  assert.match(outputs(turns, 'analyst'), /analyst write refused: /)
  assert.doesNotMatch(outputs(turns, 'analyst'), /ANALYST WRITE ALLOWED/)
  // One skeptic for each skeptic lens on claude, and the late skeptics on another family.
  assert.deepEqual(firstTurns(turns, 'skeptic').map((turn) => turn.provider), ['claude'])
  assert.deepEqual(firstTurns(turns, 'late-skeptic').map((turn) => turn.provider), ['codex'])
  // The conceded high objection went to the user before the dossier.
  const held = run.channel.posted.find((batch) => batch.batch === 'held.hyp-001.1')
  assert.deepEqual(held?.questions[0]?.options, ['Accept and continue', 'Stop the run'])

  // Each domain command output is in the run store with its command line as the source. The store keeps equal outputs one time.
  const commands = (await deps.egress.artifacts.list()).filter(({ meta }) => meta.labels?.hypothesis === 'hyp-001')
  assert.deepEqual(new Set(commands.map(({ meta }) => meta.labels?.command)), new Set(['known', 'inject', 'reproduce']))
  for (const { meta } of commands) assert.deepEqual(meta.source, { command: `node research/run.mjs ${meta.labels?.command} 'prereg/hyp-001-v2.md'` })
  // The reproduction ran on a clean checkout, not in the worktree of the run branch, and matched the calibration.
  const reproduce = commands.find(({ meta }) => meta.labels?.command === 'reproduce')
  const reproduced = new TextDecoder().decode((await deps.egress.artifacts.get(reproduce?.id ?? '')) ?? new Uint8Array())
  const cwd = /reproduce of hyp-001 in (.+)/.exec(reproduced)?.[1]
  assert.ok(cwd)
  assert.notEqual(cwd, worktreePath(join(deps.dir, 'branches'), branch))
  assert.match(result.report, /Reproduction at [0-9a-f]{12} \(output artifact [0-9a-f]{64}\): PASS/)

  // The pushed branch has the analysis, the analyst note and the dossier.
  const show = (path: string) => execFileSync('git', ['--git-dir', origin, 'show', `${branch}:${path}`]).toString()
  assert.match(show('analysis/hyp-001/analyze.mjs'), /export const recall = 0\.95/)
  assert.match(show('analysis/hyp-001/notes.md'), /known set only/)
  assert.match(show('dossier/hyp-001.md'), /hyp-001/)

  // One draft PR, one review loop pass, then ready for review. The user merges.
  assert.equal(pulls.opened.length, 1)
  assert.equal(pulls.opened[0]?.head, branch)
  assert.equal(pulls.opened[0]?.title, 'Quiet dwarf galaxies')
  assert.match(pulls.opened[0]?.body ?? '', /dossier\/hyp-001\.md/)
  assert.match(pulls.opened[0]?.body ?? '', /\(RG1\)[\s\S]*\(RG10\)/)
  assert.equal(deps.ledger.get<{ result: { pass: boolean } }>('step:review.1')?.result.pass, true)
  assert.deepEqual(pulls.ready, [9])
  assert.deepEqual(pulls.merges, [])
  const report = readFileSync(join(deps.dir, 'report.md'), 'utf8')
  assert.equal(report, result.report)
  assert.match(report, /\(RG1\)[\s\S]*\(RG10\)/)
  assert.match(report, /https:\/\/github\.com\/acme\/app\/pull\/9/)

  // The same run ID resumes from the ledger and makes no model call.
  const again: Turn[] = []
  const second = await runResearch(run.repo, run.runs, run.input, { channel: run.channel.channel, dispatch: scriptedDispatch(researchScript(), again) })
  assert.equal(second.result.status, 'ready', second.result.report)
  assert.equal(again.length, 0)
})

test('research: a second failed calibration blocks the run before the push', { timeout: 120_000 }, async () => {
  const { result, origin, pulls, turns } = await dossierRun('d2', { lowRecall: true })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /Calibration round 2 of hyp-001 failed \(known recall 0\.6, threshold 0\.9\)/)
  assert.match(result.report, /\(local, not pushed\)/)
  assert.ok(!turns.some((turn) => turn.role === 'skeptic'))
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})

test('research: a reproduction that gives other hashes blocks the run before the push', { timeout: 120_000 }, async () => {
  const { result, origin, pulls } = await dossierRun('d3', { unstable: true })
  assert.equal(result.status, 'blocked', result.report)
  assert.match(result.report, /The reproduction on a clean checkout of [0-9a-f]{12} failed/)
  assert.match(result.report, /out\/hyp-001\/known\.txt: expected [0-9a-f]{64}, reproduce gave [0-9a-f]{64}/)
  assert.equal(refs(origin), 'refs/heads/main\n')
  assert.deepEqual(pulls.opened, [])
})

test('research: the user stops the run at a conceded objection, so no dossier exists', { timeout: 120_000 }, async () => {
  const { result, origin, turns } = await dossierRun('d4', {}, { 'held.hyp-001.1': '/answer\nQ1: b' })
  assert.equal(result.status, 'stopped', result.report)
  assert.match(result.report, /You stopped the run at the conceded objections obj-001 of hyp-001, before the dossier\./)
  assert.ok(!turns.some((turn) => turn.role === 'writer'))
  assert.equal(refs(origin), 'refs/heads/main\n')
})
