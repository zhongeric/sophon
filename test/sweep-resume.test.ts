import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ScanBoxes } from '../src/core/fanout.ts'
import type { SweepResult } from '../src/core/research-sweep.ts'
import { research } from '../src/core/workflows/research.ts'
import { nodeResearch } from '../src/node/platform.ts'
import { fakePulls } from './support/develop.ts'
import { credentials, memoryChannel, module } from './support/fixture.ts'
import { archive, notebook, prices, researchInput, researchScript, runResearch, sweepConfig } from './support/research.ts'
import { scriptedDispatch } from './support/scripted-model.ts'

const config = { checks: { smoke: 'true' }, research: sweepConfig({ targets: 100 }) }
const answers = { pick: '/answer\nQ1: a' }

/** Wraps the local scan boxes: a short poll interval, and each started command in started. */
function recorded(started: string[]) {
  return (local: ScanBoxes): ScanBoxes => ({
    ...local,
    pollMs: 20,
    start(slot, unit) {
      started.push(unit.command)
      return local.start(slot, unit)
    },
  })
}

const sweepOf = (ledger: { get<T>(key: string): T | undefined }) => ledger.get<{ result: SweepResult }>('step:sweep.hyp-001')?.result

test('sweep resume: a sweep of 100 targets stopped in the middle gives the table of an unstopped sweep, and runs each job once', { timeout: 600_000 }, async () => {
  // The unstopped sweep.
  const plain = notebook({ config })
  const { result: unstopped, deps: unstoppedDeps } = await runResearch(plain.repo, mkdtempSync(join(tmpdir(), 'factory-sweep-runs-')), researchInput(plain.base, 'w1'), {
    channel: memoryChannel(answers).channel,
    dispatch: scriptedDispatch(researchScript(), []),
    scanBoxes: recorded([]),
  })
  assert.equal(unstopped.status, 'ready', unstopped.report)
  const expected = sweepOf(unstoppedDeps.ledger)
  assert.ok(expected?.table)
  assert.equal(expected.trials, 200)

  // The same sweep, stopped after 50 recorded fetches, then resumed with the same run ID.
  const { repo, base, origin } = notebook({ config })
  const runsDir = mkdtempSync(join(tmpdir(), 'factory-sweep-runs-'))
  const input = researchInput(base, 'w2')
  const { channel } = memoryChannel(answers)
  const pages = archive()
  const started: string[] = []
  const deps = await nodeResearch({
    channel,
    credentials,
    dispatch: scriptedDispatch(researchScript(), []),
    env: { ARCHIVE_TOKEN: 'token-1' },
    fetch: pages.fetch,
    input,
    log: () => {},
    module,
    prices,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir,
  })
  if (deps.scanBoxes) deps.scanBoxes = recorded(started)(deps.scanBoxes)
  const ledger = deps.ledger
  let fetches = 0
  deps.ledger = {
    ...ledger,
    put(key, value) {
      ledger.put(key, value)
      if (key.startsWith('step:sweep-fetch.') && ++fetches === 50) throw new Error('stopped in the sweep')
    },
  }
  await assert.rejects(research(input, deps), /stopped in the sweep/)
  assert.ok(started.length >= 50 && started.length < 100, String(started.length))
  assert.ok(started.every((command) => command.includes(' sweep-fetch ')))

  const { result, deps: resumed } = await runResearch(repo, runsDir, input, { channel, dispatch: scriptedDispatch(researchScript(), []), fetch: pages.fetch, scanBoxes: recorded(started) })
  assert.equal(result.status, 'ready', result.report)
  const swept = sweepOf(resumed.ledger)
  assert.equal(swept?.table, expected.table)
  assert.equal(swept?.trials, 200)
  assert.deepEqual(swept?.failedUnits, [])

  // Over both calls, each fetch and each unit started one time, and the archive got one request for each target.
  const jobs = (kind: string) => started.filter((command) => command.includes(' ' + kind + ' '))
  assert.equal(jobs('sweep-fetch').length, 100)
  assert.equal(new Set(jobs('sweep-fetch')).size, 100)
  assert.equal(jobs('sweep-unit').length, 100)
  assert.equal(new Set(jobs('sweep-unit')).size, 100)
  const targets = pages.fetched.filter((request) => request.url.includes('/fields/'))
  assert.equal(targets.length, 100)
  assert.equal(new Set(targets.map((request) => request.url)).size, 100)
  assert.ok(targets.every((request) => request.key === 'token-1'))

  // The dossier and the report show the host trial count, not the trials of the writer.
  const dossier = execFileSync('git', ['--git-dir', origin, 'show', 'factory/research-w2:dossier/hyp-001.md']).toString()
  assert.match(dossier, /- Trials: 200\n/)
  assert.match(result.report, new RegExp('- Sweep: PASS, plan output [0-9a-f]{64}, 100 units, 0 retries, 200 trials, candidate table ' + expected.table))
})
