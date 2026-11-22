import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { RepoConfig } from '../src/core/checks.ts'
import {
  attemptLimit,
  holdoutRefusal,
  recordUnitResult,
  runUnits,
  slotName,
  unitConflicts,
  unitInputs,
  unitsFiles,
  type FanOut,
  type ScanBoxes,
  type ScanPoll,
} from '../src/core/fanout.ts'
import type { Ledger } from '../src/core/ledger.ts'
import { PlannedStop } from '../src/core/planned-stop.ts'
import type { PlanUnit } from '../src/core/research-commands.ts'
import type { ResearchConfig } from '../src/core/research.ts'
import { computeOf } from '../src/core/usage.ts'
import { memoryArtifacts } from './support/artifacts.ts'

const research: ResearchConfig = {
  egress: ['archive.example.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: ['literature'], skeptic: ['systematics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Known set'],
  commands: {
    known: 'nb known {prereg}',
    inject: 'nb inject {prereg}',
    evaluate: 'nb evaluate {prereg}',
    reproduce: 'nb reproduce {prereg}',
    plan: 'nb plan {prereg}',
    fetch: 'nb fetch {prereg} {target}',
    unit: 'nb unit {prereg} {unit}',
    merge: 'nb merge {prereg} {units}',
  },
}
const config: RepoConfig = { stack: 'Python', checks: {}, research }
const bytes = (text: string) => new TextEncoder().encode(text)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const unit = (id: string, targets: string[] = []): PlanUnit => ({ id, targets, expected_seconds: 1 })

function memoryLedger(): Ledger & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>()
  return {
    entries,
    get: <T>(key: string) => (entries.has(key) ? (structuredClone(entries.get(key)) as T) : undefined),
    put: (key, value) => void entries.set(key, structuredClone(value)),
  }
}

/**
 * What each attempt of a unit does, in order: done after one running poll (ok), a bad last line, a wrong hash, exit 2,
 * exit null, the box loses the job, it runs until the kill, or the start is full.
 */
type Kind = 'ok' | 'bad-line' | 'bad-hash' | 'exit' | 'timeout' | 'missing' | 'hang' | 'full'

function fakeBoxes(kinds: Record<string, Kind[]>) {
  const started: { slot: string; command: string; timeoutMs: number; inputs: string[] }[] = []
  const killed: string[] = []
  const polls: string[] = []
  const slots = new Map<string, { kind: Kind; polls: number }>()
  const files = new Map<string, Uint8Array>()
  const done = (exitCode: number | null, output: string): ScanPoll => ({ state: 'done', result: { exit_code: exitCode, output } })
  const boxes: ScanBoxes = {
    instance: { type: 'standard-1', vcpu: 1, gib: 4 },
    maxUnitMs: 60_000,
    pollMs: 1000,
    async start(slot, job) {
      const id = /\/(.+)-\d+$/.exec(slot)?.[1] ?? ''
      const kind = kinds[id]?.shift() ?? 'ok'
      if (kind === 'full') return { full: true }
      started.push({ slot, command: job.command, timeoutMs: job.timeoutMs, inputs: job.inputs.map((file) => file.path) })
      slots.set(slot, { kind, polls: 0 })
      return { job: `job-${started.length}` }
    },
    async poll(slot) {
      polls.push(slot)
      const state = slots.get(slot)
      if (!state || state.kind === 'missing') return { state: 'missing' }
      state.polls += 1
      if (state.kind === 'hang' || state.polls === 1) return { state: 'running' }
      if (state.kind === 'exit') return done(2, 'boom')
      if (state.kind === 'timeout') return done(null, '[host] killed')
      const text = `rows of ${slot}`
      files.set(`${slot}:out.txt`, bytes(text))
      if (state.kind === 'bad-line') return done(0, 'no JSON line')
      return done(0, JSON.stringify({ outputs: { 'out.txt': state.kind === 'bad-hash' ? '0'.repeat(64) : sha(text) } }))
    },
    async kill(slot) {
      killed.push(slot)
    },
    async read(slot, path) {
      const found = files.get(`${slot}:${path}`)
      if (!found) throw new Error(`no file ${path}`)
      return found
    },
  }
  return { boxes, started, killed, polls }
}

function fanOut(boxes: ScanBoxes, ledger: Ledger, overrides: Partial<FanOut> = {}) {
  const clock = { now: 1_000_000 }
  const artifacts = memoryArtifacts()
  const options: FanOut = {
    ledger,
    boxes,
    artifacts,
    config,
    runId: 'run-1',
    commit: 'c0ffee',
    prereg: { hypothesis: 'hyp-001', path: 'prereg/hyp-001-v1.md', sha256: 'a'.repeat(64) },
    round: 1,
    parallel: 4,
    inputs: async () => [{ path: 'notebook.txt', data: bytes('notebook') }],
    log: () => {},
    wait: async (ms) => void (clock.now += ms),
    now: () => clock.now,
    ...overrides,
  }
  return { options, artifacts, clock }
}

test('fanout: over-time, a lost box and a non-zero exit each count as an attempt on a new slot', async () => {
  const { boxes, started, killed } = fakeBoxes({ u1: ['hang', 'missing', 'exit', 'ok'] })
  const ledger = memoryLedger()
  const { options, artifacts } = fanOut(boxes, ledger)
  const [result] = await runUnits([unit('u1')], options)
  assert.equal(result?.status, 'done')
  assert.equal(result?.attempts, 4)
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/u1-1', 'run-1/u1-2', 'run-1/u1-3', 'run-1/u1-4'])
  assert.deepEqual(killed, ['run-1/u1-1'])
  // The limit is 3 times the expected second, and the command is the unit command of the config.
  assert.equal(started[0]?.timeoutMs, 3000)
  assert.equal(started[0]?.command, "nb unit 'prereg/hyp-001-v1.md' 'u1'")
  const id = result?.outputs['out.txt'] ?? ''
  assert.equal(id, sha('rows of run-1/u1-4'))
  assert.deepEqual((await artifacts.meta(id))?.labels, { hypothesis: 'hyp-001', unit: 'u1', round: '1', path: 'out.txt' })
  const reasons = ledger.get<{ reason?: string }[]>(`attempts.unit.c0ffee.${'a'.repeat(64)}.u1`)?.map((attempt) => attempt.reason)
  assert.match(reasons?.[0] ?? '', /ran over its time limit of 3000 ms/)
  assert.match(reasons?.[1] ?? '', /lost the job/)
  assert.match(reasons?.[2] ?? '', /exited with code 2/)
  assert.equal(reasons?.[3], undefined)
  // Each attempt has a compute entry of the scan instance, and each entry has an end.
  const rows = computeOf(ledger)
  assert.deepEqual(rows.map((row) => row.step), [1, 2, 3, 4].map((n) => `unit.hyp-001.1.u1.${n}`))
  assert.ok(rows.every((row) => row.instance?.type === 'standard-1'))
  assert.equal(rows[0]?.seconds, 4)
})

test('fanout: after 3 restarts the unit fails with the last reason, and a bad last line and a wrong hash count', async () => {
  const { boxes, started } = fakeBoxes({ u1: ['bad-line', 'bad-hash', 'timeout', 'missing', 'ok'] })
  const { options } = fanOut(boxes, memoryLedger())
  const [result] = await runUnits([unit('u1')], options)
  assert.equal(result?.status, 'failed')
  assert.equal(result?.attempts, 4)
  assert.deepEqual(result?.outputs, {})
  assert.match(result?.reason ?? '', /^4 attempts failed\. The last reason: the box of run-1\/u1-4 lost the job$/)
  assert.equal(started.length, 4)
})

test('fanout: a full pool waits one poll interval and tries again without counting an attempt', async () => {
  const { boxes, started } = fakeBoxes({ u1: ['full', 'full', 'ok'] })
  const { options, clock } = fanOut(boxes, memoryLedger())
  const before = clock.now
  const [result] = await runUnits([unit('u1')], options)
  assert.equal(result?.status, 'done')
  assert.equal(result?.attempts, 1)
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/u1-1'])
  // Two waits for the full pool and one for the running poll.
  assert.equal(clock.now - before, 3000)
})

test('fanout: a resume polls the recorded job and does not run a finished unit again', async () => {
  const { boxes, started, polls } = fakeBoxes({})
  const ledger = memoryLedger()
  let stopped = false
  const pausing: Ledger = {
    get: ledger.get,
    put: ledger.put,
    safePoint(nextMs) {
      if (nextMs !== undefined && !stopped) {
        stopped = true
        throw new PlannedStop('the call has no time left')
      }
    },
  }
  const units = [unit('u1')]
  await assert.rejects(runUnits(units, fanOut(boxes, pausing).options), PlannedStop)
  assert.equal(started.length, 1)
  const [result] = await runUnits(units, fanOut(boxes, ledger).options)
  assert.equal(result?.status, 'done')
  assert.equal(started.length, 1)
  assert.deepEqual(polls, ['run-1/u1-1', 'run-1/u1-1'])
  const failing: ScanBoxes = { ...boxes, start: async () => assert.fail('a finished unit must not start again') }
  assert.deepEqual(await runUnits(units, fanOut(failing, ledger).options), [result])
})

test('fanout: a planned stop keeps the compute entry of the attempt open', async () => {
  const { boxes } = fakeBoxes({})
  const ledger = memoryLedger()
  const pausing: Ledger = {
    get: ledger.get,
    put: ledger.put,
    safePoint(nextMs) {
      if (nextMs !== undefined) throw new PlannedStop('the call has no time left')
    },
  }
  await assert.rejects(runUnits([unit('u1')], fanOut(boxes, pausing).options), PlannedStop)
  const entries = ledger.get<{ entries: Record<string, { endedAt?: number }> }>('compute')?.entries ?? {}
  assert.deepEqual(Object.values(entries).map((entry) => entry.endedAt), [undefined])
})

test('fanout: a later result with another SHA-256 goes to the conflict list, and the first result stays', async () => {
  const ledger = memoryLedger()
  const first = { id: 'u1', status: 'done' as const, attempts: 1, outputs: { 'b.txt': 'b'.repeat(64), 'a.txt': 'a'.repeat(64) } }
  assert.deepEqual(await recordUnitResult(ledger, 'unit.k', first), first)
  // The same outputs in another order are the same result.
  assert.deepEqual(await recordUnitResult(ledger, 'unit.k', { ...first, attempts: 2, outputs: { 'a.txt': 'a'.repeat(64), 'b.txt': 'b'.repeat(64) } }), first)
  assert.deepEqual(unitConflicts(ledger), [])
  const second = { ...first, outputs: { 'a.txt': 'c'.repeat(64) } }
  assert.deepEqual(await recordUnitResult(ledger, 'unit.k', second), first)
  await recordUnitResult(ledger, 'unit.k', second)
  const conflicts = unitConflicts(ledger)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]?.unit, 'u1')
  assert.equal(conflicts[0]?.key, 'unit.k')
  assert.notEqual(conflicts[0]?.first, conflicts[0]?.second)
  assert.match(conflicts[0]?.second ?? '', /^[0-9a-f]{64}$/)
})

test('fanout: a plan with a holdout target is refused', () => {
  assert.match(holdoutRefusal(['field-a', 'ngc-1234'], ['ngc-1234']) ?? '', /holdout targets ngc-1234/)
  assert.equal(holdoutRefusal(['field-a'], ['ngc-1234']), null)
})

test('fanout: zero units start no box', async () => {
  const { boxes, started } = fakeBoxes({})
  assert.deepEqual(await runUnits([], fanOut(boxes, memoryLedger()).options), [])
  assert.equal(started.length, 0)
})

test('fanout: the attempt limit is the smallest of 3 times the expected time, the unit timeout and the box limit', () => {
  assert.equal(attemptLimit(10, undefined, 60_000), 30_000)
  assert.equal(attemptLimit(10, 5_000, 60_000), 5_000)
  assert.equal(attemptLimit(100, 400_000, 60_000), 60_000)
})

test('fanout: research.timeouts.unit limits the box timeout', async () => {
  const { boxes, started } = fakeBoxes({})
  const limited: RepoConfig = { ...config, research: { ...research, timeouts: { unit: 1500 } } }
  await runUnits([unit('u1')], fanOut(boxes, memoryLedger(), { config: limited }).options)
  assert.equal(started[0]?.timeoutMs, 1500)
})

test('fanout: slot names keep the part pattern for each run ID and unit ID', () => {
  assert.equal(slotName('run-1', 'u1', 2), 'run-1/u1-2')
  const long = slotName('research.20261122 run', `${'x'.repeat(70)}.y`, 3)
  assert.match(long, /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(long, slotName('research.20261122 run', `${'x'.repeat(70)}.z`, 3))
})

test('fanout: unit inputs put the fetched data over the commit files, and the units directory has a manifest', async () => {
  const artifacts = memoryArtifacts()
  const data = await artifacts.put(bytes('field data'), { source: { command: 'nb fetch' }, media_type: 'application/octet-stream' })
  const inputs = unitInputs(async () => [{ path: 'data/a.txt', data: bytes('old') }, { path: 'run.py', data: bytes('code') }], { a: { 'data/a.txt': data } }, artifacts)
  const files = await inputs(unit('u1', ['a']))
  assert.deepEqual(files.map((file) => [file.path, new TextDecoder().decode(file.data)]), [['run.py', 'code'], ['data/a.txt', 'field data']])
  const units = await unitsFiles(
    [
      { id: 'u1', status: 'done', attempts: 1, outputs: { 'part.txt': data } },
      { id: 'u2', status: 'failed', attempts: 4, reason: 'lost', outputs: {} },
    ],
    artifacts,
  )
  assert.deepEqual(units.map((file) => file.path), ['.agent-factory/units/u1/part.txt', '.agent-factory/units/units.json'])
  assert.deepEqual(JSON.parse(new TextDecoder().decode(units[1]?.data)), {
    units: [
      { id: 'u1', status: 'done', attempts: 1 },
      { id: 'u2', status: 'failed', attempts: 4, reason: 'lost' },
    ],
  })
})
