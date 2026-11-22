import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ScanBoxes } from '../src/core/fanout.ts'
import type { Ledger } from '../src/core/ledger.ts'
import { runDomainCommand } from '../src/core/research-commands.ts'
import { StopError } from '../src/core/stop.ts'
import { memoryChannel } from './support/fixture.ts'
import { fanOutConfig, notebook, researchInput, researchScript, runResearch } from './support/research.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const runsDir = () => mkdtempSync(join(tmpdir(), 'factory-fanout-runs-'))
const config = { checks: { smoke: 'true' }, research: fanOutConfig }

type Round = { head: string; pass: boolean; outputs: Record<string, string>; fanout?: { retries: number; failed: string[]; units: { id: string; attempts: number }[] } }

/** The local scan boxes, but the first poll of the first attempt of inject-2 kills the job and tells that the box lost it. */
function losing(local: ScanBoxes): ScanBoxes {
  let first: string | undefined
  let lost = false
  return {
    ...local,
    pollMs: 20,
    async start(slot, unit) {
      if (first === undefined && unit.command.endsWith("'inject-2'")) first = slot
      return local.start(slot, unit)
    },
    async poll(slot) {
      if (lost || slot !== first) return local.poll(slot)
      lost = true
      await local.kill(slot)
      return { state: 'missing' }
    },
  }
}

const calibrations = (ledger: Ledger): Round[] => {
  const rounds: Round[] = []
  for (let round = 1; ; round++) {
    const recorded = ledger.get<{ result: Round }>(`step:calibrate.hyp-001.${round}`)
    if (!recorded) return rounds
    rounds.push(recorded.result)
  }
}

test('research fan-out: a lost unit starts again, and merge gives the hashes of known and inject', { timeout: 300_000 }, async () => {
  const { repo, base } = notebook({ config })
  const { channel, notices, posted } = memoryChannel({ pick: '/answer\nQ1: a' })
  const { result, deps } = await runResearch(repo, runsDir(), researchInput(base, 'f1'), { channel, dispatch: scriptedDispatch(researchScript(), []), scanBoxes: losing })
  assert.equal(result.status, 'ready', result.report)
  // The intake comes before plan, so the cap question says that the compute cost is unknown.
  const cap = posted.find((post) => post.batch === 'intake')?.questions.find((question) => question.rule === 'spend')
  assert.match(cap?.why ?? '', /The compute cost is unknown until stage 6 runs plan\./)
  const rounds = calibrations(deps.ledger)
  assert.equal(rounds[0]?.fanout?.retries, 1)
  assert.deepEqual(rounds[0]?.fanout?.failed, [])
  assert.deepEqual(rounds[0]?.fanout?.units.map((unit) => [unit.id, unit.attempts]), [['known', 1], ['inject-1', 1], ['inject-2', 2]])
  const final = rounds.at(-1)
  assert.equal(final?.pass, true)
  // One known and one inject of the same notebook on a clean checkout of the same head give the same files.
  const [frozen] = deps.ledger.get<{ path: string }[]>('frozen') ?? []
  assert.ok(final && frozen)
  const box = await deps.cleanBox(final.head, 'check')
  const known = await runDomainCommand(deps.config, box, 'known', frozen.path)
  const inject = await runDomainCommand(deps.config, box, 'inject', frozen.path)
  assert.deepEqual(final.outputs, { ...known.json?.outputs, ...inject.json?.outputs })
  assert.match(result.report, /- Calibration round 1 at [0-9a-f]{12}: FAIL[^\n]*\n {2}- Fan-out: plan output [0-9a-f]{64}, 3 units, 1 retries, no failed unit/)
  assert.match(result.report, /\| calibrate\.hyp-001\.1\.plan \| local \|/)
  assert.match(result.report, /\| calibrate\.hyp-001\.1\.merge \| local \|/)
  assert.match(result.report, /\| unit\.hyp-001\.1\.inject-2\.2 \| local \|/)
  assert.ok(notices.some((text) => /has 3 units of 180 expected seconds\. The expected compute cost is unknown/.test(text)), notices.join('\n'))
})

test('research fan-out: a budget without CONTAINER_PRICES stops before any work', { timeout: 120_000 }, async () => {
  const { repo, base } = notebook({ config })
  const turns: Turn[] = []
  await assert.rejects(
    runResearch(repo, runsDir(), researchInput(base, 'f2', { budget: 40 }), { channel: memoryChannel().channel, dispatch: scriptedDispatch(researchScript(), turns) }),
    (error) => error instanceof StopError && /CONTAINER_PRICES is not set/.test(error.message),
  )
  assert.equal(turns.length, 0)
})
