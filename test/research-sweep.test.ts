import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RepoConfig } from '../src/core/checks.ts'
import type { InputFile, ScanBoxes } from '../src/core/fanout.ts'
import type { Ledger } from '../src/core/ledger.ts'
import type { Plan } from '../src/core/research-commands.ts'
import type { ResearchConfig } from '../src/core/research.ts'
import { runSweep, type SweepBox, type SweepContext } from '../src/core/research-sweep.ts'
import { StopError } from '../src/core/stop.ts'
import { research as researchRun } from '../src/core/workflows/research.ts'
import { nodeResearch } from '../src/node/platform.ts'
import { memoryArtifacts } from './support/artifacts.ts'
import { fakePulls } from './support/develop.ts'
import { credentials, memoryChannel, module } from './support/fixture.ts'
import { archive, memoryData, notebook, prices, researchInput, researchScript, sweepConfig } from './support/research.ts'
import { scriptedDispatch, type Turn } from './support/scripted-model.ts'

const research: ResearchConfig = {
  egress: ['archive.example.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: ['literature'], skeptic: ['systematics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Known set'],
  commands: { known: 'nb known {prereg}', inject: 'nb inject {prereg}', evaluate: 'nb evaluate {prereg}', reproduce: 'nb reproduce {prereg}' },
  sweep: { plan: 'nb plan {prereg}', fetch: 'nb fetch {prereg} {target}', unit: 'nb unit {prereg} {unit}', merge: 'nb merge {prereg} {units}', fetch_rate: 5, fetch_parallel: 2 },
}
const config: RepoConfig = { stack: 'Python', checks: {}, research }
const bytes = (text: string) => new TextEncoder().encode(text)
const decode = (data: Uint8Array) => new TextDecoder().decode(data)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function memoryLedger(): Ledger {
  const entries = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (entries.has(key) ? (structuredClone(entries.get(key)) as T) : undefined),
    put: (key, value) => void entries.set(key, structuredClone(value)),
  }
}

/** What each attempt of a job does: it passes, exits with code 2, or prints a negative tls_passes. */
type Kind = 'ok' | 'exit' | 'bad-passes'

/**
 * Scan boxes in memory. A fetch writes data/<target>.txt with the text of data(target). A unit writes candidate.txt
 * with its ID and the data of its inputs, and prints tls_passes 1. kinds gives the attempts of a target or a unit.
 */
function fakeBoxes(kinds: Record<string, Kind[]> = {}, data = (target: string) => 'data of ' + target) {
  const started: { slot: string; name: string; egress: boolean; inputs: string[] }[] = []
  const results = new Map<string, { exitCode: number; output: string; files: Map<string, Uint8Array> }>()
  const boxes: ScanBoxes = {
    instance: null,
    maxUnitMs: 60_000,
    pollMs: 1,
    egress: true,
    async start(slot, job) {
      const name = /'([^']*)'$/.exec(job.command)?.[1] ?? ''
      started.push({ slot, name, egress: job.egress === true, inputs: job.inputs.map((file) => file.path) })
      const kind = kinds[name]?.shift() ?? 'ok'
      const files = new Map<string, Uint8Array>()
      let json: Record<string, unknown>
      if (job.command.startsWith('nb fetch ')) {
        const path = 'data/' + name + '.txt'
        files.set(path, bytes(data(name)))
        json = { outputs: { [path]: sha(data(name)) } }
      } else {
        const text = name + ': ' + job.inputs.filter((file) => file.path.startsWith('data/')).map((file) => decode(file.data)).join(', ')
        files.set('candidate.txt', bytes(text))
        json = { outputs: { 'candidate.txt': sha(text) }, tls_passes: kind === 'bad-passes' ? -1 : 1 }
      }
      results.set(slot, kind === 'exit' ? { exitCode: 2, output: 'failed\n', files } : { exitCode: 0, output: JSON.stringify(json) + '\n', files })
      return { job: 'job-' + started.length }
    },
    async poll(slot) {
      const result = results.get(slot)
      return result ? { state: 'done', result: { exit_code: result.exitCode, output: result.output } } : { state: 'missing' }
    },
    async kill() {},
    async read(slot, path) {
      const file = results.get(slot)?.files.get(path)
      if (!file) throw new Error('no file ' + path)
      return file
    },
  }
  return { boxes, started }
}

/** A sweep context over the boxes. Its clean box answers plan with the plan, and merge with the done units of units.json. */
function context(plan: Plan, boxes: ScanBoxes) {
  const store = memoryData()
  const artifacts = memoryArtifacts()
  const merges: { files: string[]; units: string[] }[] = []
  const checks: string[] = []
  const notices: string[] = []
  let clock = 0
  const cleanBox = async (key: string, files: InputFile[] = []): Promise<SweepBox> => ({
    id: key,
    async run(command) {
      if (command.startsWith('nb plan ')) return { exit_code: 0, output: JSON.stringify(plan) + '\n' }
      const manifest = files.find((file) => file.path.endsWith('/units.json'))
      const units: { id: string; status: string }[] = manifest ? JSON.parse(decode(manifest.data)).units : []
      merges.push({ files: files.map((file) => file.path), units: units.map((unit) => unit.id) })
      const candidates = units.filter((unit) => unit.status === 'done').map((unit) => ({ unit: unit.id }))
      return { exit_code: 0, output: JSON.stringify({ candidates }) + '\n' }
    },
  })
  const sweep: SweepContext = {
    ledger: memoryLedger(),
    config,
    boxes,
    store,
    artifacts,
    runId: 'run-1',
    commit: 'c0ffee',
    prereg: { hypothesis: 'hyp-001', path: 'prereg/hyp-001-v1.md', sha256: sha('prereg') },
    holdoutTargets: ['ngc-1234'],
    parallel: 2,
    cleanBox,
    files: async () => [{ path: 'nb.py', data: bytes('print(1)') }],
    check: async () => void checks.push('check'),
    notice: async (seconds, units) => void notices.push(units + ' units of ' + seconds + ' s'),
    meter: (_step, _box, run) => run(),
    log: () => {},
    wait: async () => {},
    now: () => (clock += 1),
  }
  return { sweep, store, artifacts, merges, checks, notices }
}

const unitOf = (id: string, targets: string[]) => ({ id, targets, expected_seconds: 10 })
const threeTargets = ['field-a', 'field-b', 'field-c']

test('sweep: a fetch that fails 1 + 3 times fails only the units of its target, and the sweep goes on', async () => {
  const { boxes, started } = fakeBoxes({ 'field-b': ['exit', 'exit', 'exit', 'exit'] })
  const plan = { targets: threeTargets, units: [unitOf('u-a', ['field-a']), unitOf('u-b', ['field-b']), unitOf('u-c', ['field-c'])] }
  const { sweep, artifacts, checks, notices } = context(plan, boxes)
  const result = await runSweep(sweep)
  assert.equal(result.reason, '')
  assert.equal(started.filter((job) => job.name === 'field-b').length, 4)
  assert.deepEqual(result.failedTargets.map((target) => target.target), ['field-b'])
  assert.match(result.failedTargets[0]?.reason ?? '', /4 attempts failed\. The last reason: the fetch exited with code 2/)
  assert.deepEqual(result.failedUnits.map((unit) => unit.id), ['u-b'])
  assert.match(result.failedUnits[0]?.reason ?? '', /^the fetch of field-b failed: 4 attempts failed/)
  assert.equal(started.some((job) => job.name === 'u-b'), false)
  assert.equal(result.retries, 3)
  assert.equal(result.trials, 4)
  assert.deepEqual(checks, ['check', 'check'])
  assert.deepEqual(notices, ['3 units of 30 s'])
  // Only fetch jobs get egress, and fetch slots and unit slots are in different pools.
  for (const job of started) assert.equal(job.egress, !job.name.startsWith('u-'), job.name)
  const pools = (units: boolean) => new Set(started.filter((job) => job.name.startsWith('u-') === units).map((job) => job.slot.split('/')[0] ?? ''))
  assert.ok([...pools(false)].every((pool) => pool.endsWith('-fetch')))
  assert.ok([...pools(true)].every((pool) => pool.endsWith('-sweep')))
  // A unit gets the commit files and the data of its target from the store.
  assert.deepEqual(started.find((job) => job.name === 'u-a')?.inputs, ['nb.py', 'data/field-a.txt'])
  const table = await artifacts.get(result.table ?? '')
  assert.deepEqual(JSON.parse(decode(table ?? new Uint8Array())), { candidates: [{ unit: 'u-a' }, { unit: 'u-c' }] })
})

test('sweep: the trial count adds the targets and tls_passes of done units only, and a bad tls_passes fails the unit', async () => {
  const { boxes, started } = fakeBoxes({ 'u-c': ['bad-passes', 'bad-passes', 'bad-passes', 'bad-passes'] })
  const plan = { targets: threeTargets, units: [unitOf('u-ab', ['field-a', 'field-b']), unitOf('u-c', ['field-c'])] }
  const result = await runSweep(context(plan, boxes).sweep)
  assert.equal(started.filter((job) => job.name === 'u-c').length, 4)
  assert.deepEqual(result.failedUnits.map((unit) => unit.id), ['u-c'])
  assert.match(result.failedUnits[0]?.reason ?? '', /tls_passes/)
  // u-ab has 2 targets and 1 TLS pass. u-c failed, so it adds nothing.
  assert.equal(result.trials, 3)
})

test('sweep: zero units give an empty table and 0 trials without a fetch or a merge', async () => {
  const { boxes, started } = fakeBoxes()
  const { sweep, artifacts, merges } = context({ targets: [], units: [] }, boxes)
  const result = await runSweep(sweep)
  assert.equal(result.reason, '')
  assert.equal(result.trials, 0)
  assert.equal(result.units, 0)
  assert.deepEqual(started, [])
  assert.deepEqual(merges, [])
  assert.equal(result.table, sha('{"candidates":[]}\n'))
  assert.ok(await artifacts.get(result.table ?? ''))
})

test('sweep: a holdout target fails the sweep before any fetch', async () => {
  const { boxes, started } = fakeBoxes()
  const { sweep, checks, notices } = context({ targets: ['field-a', 'ngc-1234'], units: [unitOf('u-a', ['field-a', 'ngc-1234'])] }, boxes)
  const result = await runSweep(sweep)
  assert.match(result.reason, /^sweep plan: .*ngc-1234/)
  assert.equal(result.table, null)
  assert.deepEqual(started, [])
  assert.deepEqual(checks, [])
  assert.deepEqual(notices, [])
})

test('sweep: merge gets the units directory in unit ID order', async () => {
  const { boxes } = fakeBoxes()
  const plan = { targets: threeTargets, units: [unitOf('u-c', ['field-c']), unitOf('u-a', ['field-a']), unitOf('u-b', ['field-b'])] }
  const { sweep, merges } = context(plan, boxes)
  assert.equal((await runSweep(sweep)).reason, '')
  assert.deepEqual(merges[0]?.units, ['u-a', 'u-b', 'u-c'])
  assert.deepEqual(merges[0]?.files, [
    '.agent-factory/units/u-a/candidate.txt',
    '.agent-factory/units/u-b/candidate.txt',
    '.agent-factory/units/u-c/candidate.txt',
    '.agent-factory/units/units.json',
  ])
})

test('sweep: two targets with the same data give one object in the data store', async () => {
  const { boxes } = fakeBoxes({}, () => 'the same page')
  const plan = { targets: ['field-a', 'field-b'], units: [unitOf('u-a', ['field-a']), unitOf('u-b', ['field-b'])] }
  const { sweep, store, artifacts } = context(plan, boxes)
  assert.equal((await runSweep(sweep)).reason, '')
  assert.ok(store.objects.has(sha('the same page')))
  // One data file and the candidate file of each unit. The data files never go to the artifacts.
  assert.equal(store.objects.size, 3)
  assert.equal(await artifacts.get(sha('the same page')), null)
})

test('sweep: a second call does not run a finished fetch or unit again', async () => {
  const { boxes, started } = fakeBoxes()
  const plan = { targets: ['field-a', 'field-b'], units: [unitOf('u-a', ['field-a']), unitOf('u-b', ['field-b'])] }
  const { sweep } = context(plan, boxes)
  const first = await runSweep(sweep)
  const count = started.length
  assert.deepEqual(await runSweep(sweep), first)
  assert.equal(started.length, count)
})

type Deps = Awaited<ReturnType<typeof nodeResearch>>

/** Runs the research workflow on a sweep notebook after change(deps), and gives the error and the model turns. */
async function stopsWith(runId: string, change: (deps: Deps) => void): Promise<{ error: unknown; turns: Turn[] }> {
  const { repo, base } = notebook({ config: { checks: { smoke: 'true' }, research: sweepConfig() } })
  const turns: Turn[] = []
  const input = researchInput(base, runId)
  const deps = await nodeResearch({
    channel: memoryChannel().channel,
    credentials,
    dispatch: scriptedDispatch(researchScript(), turns),
    env: { ARCHIVE_TOKEN: 'token-1' },
    fetch: archive().fetch,
    input,
    log: () => {},
    module,
    prices,
    pulls: fakePulls().pulls,
    repo,
    reviewChannel: async () => memoryChannel().channel,
    runsDir: mkdtempSync(join(tmpdir(), 'factory-sweep-runs-')),
  })
  change(deps)
  try {
    await researchRun(input, deps)
    return { error: null, turns }
  } catch (error) {
    return { error, turns }
  }
}

test('sweep: a sweep config stops at the start without scan boxes, without egress or without a data store', { timeout: 120_000 }, async () => {
  const cases: [string, (deps: Deps) => void, RegExp][] = [
    ['s1', (deps) => void delete deps.scanBoxes, /gives no scan boxes for the sweep/],
    ['s2', (deps) => void (deps.scanBoxes &&= { ...deps.scanBoxes, egress: false }), /give no egress to the sweep fetches/],
    ['s3', (deps) => void delete deps.data, /gives no data store for the sweep files/],
  ]
  for (const [runId, change, message] of cases) {
    const { error, turns } = await stopsWith(runId, change)
    assert.ok(error instanceof StopError, String(error))
    assert.match(error.message, message)
    assert.equal(turns.length, 0)
  }
})
