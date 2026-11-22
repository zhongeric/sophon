import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RepoConfig } from '../src/core/checks.ts'
import {
  attemptLimit,
  holdoutRefusal,
  recordUnitResult,
  runUnits,
  slotName,
  treeInputs,
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
import { diskFileSystem } from '../src/node/disk.ts'
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
 * exit null, the box loses the job, it runs until the kill, the start is full, the start throws, or the first poll throws.
 */
type Kind = 'ok' | 'bad-line' | 'bad-hash' | 'exit' | 'timeout' | 'missing' | 'hang' | 'full' | 'start-error' | 'poll-error'

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
      const id = /'([^']*)'$/.exec(job.command)?.[1] ?? ''
      const kind = kinds[id]?.shift() ?? 'ok'
      if (kind === 'full') return { full: true }
      if (kind === 'start-error') throw new Error('the start RPC failed')
      started.push({ slot, command: job.command, timeoutMs: job.timeoutMs, inputs: job.inputs.map((file) => file.path) })
      slots.set(slot, { kind, polls: 0 })
      return { job: `job-${started.length}` }
    },
    async poll(slot) {
      polls.push(slot)
      const state = slots.get(slot)
      if (!state || state.kind === 'missing') return { state: 'missing' }
      state.polls += 1
      if (state.kind === 'poll-error') throw new Error('the poll RPC failed')
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
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/lane_0', 'run-1/u1-2', 'run-1/u1-3', 'run-1/u1-4'])
  assert.deepEqual(killed, ['run-1/lane_0'])
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
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/lane_0'])
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
  assert.deepEqual(polls, ['run-1/lane_0', 'run-1/lane_0'])
  const failing: ScanBoxes = { ...boxes, start: async () => assert.fail('a finished unit must not start again') }
  assert.deepEqual(await runUnits(units, fanOut(failing, ledger).options), [result])
})

test('fanout: a failed start or poll kills the slot before the next attempt', async () => {
  const { boxes, started, killed } = fakeBoxes({ u1: ['start-error', 'poll-error', 'ok'] })
  const ledger = memoryLedger()
  const [result] = await runUnits([unit('u1')], fanOut(boxes, ledger).options)
  assert.equal(result?.status, 'done')
  assert.equal(result?.attempts, 3)
  assert.deepEqual(killed, ['run-1/lane_0', 'run-1/u1-2'])
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/u1-2', 'run-1/u1-3'])
  const reasons = ledger.get<{ reason?: string }[]>(`attempts.unit.c0ffee.${'a'.repeat(64)}.u1`)?.map((attempt) => attempt.reason)
  assert.match(reasons?.[0] ?? '', /the start failed: the start RPC failed/)
  assert.match(reasons?.[1] ?? '', /the poll failed: the poll RPC failed/)
})

test('fanout: a first attempt runs in a free lane, and a retry runs on a new slot', async () => {
  const { boxes, started } = fakeBoxes({ u2: ['exit'] })
  const results = await runUnits([unit('u1'), unit('u2'), unit('u3')], fanOut(boxes, memoryLedger(), { parallel: 2 }).options)
  assert.deepEqual(results.map((result) => result.status), ['done', 'done', 'done'])
  assert.equal(started.length, 4)
  // u3 reuses the lane of a unit that ended, so the pool has only two lanes.
  assert.deepEqual([...new Set(started.map((entry) => entry.slot))].sort(), ['run-1/lane_0', 'run-1/lane_1', 'run-1/u2-2'])
})

test('fanout: after a resume, the lane of a running attempt stays busy', async () => {
  const { boxes, started } = fakeBoxes({})
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
  await assert.rejects(runUnits([unit('u1')], fanOut(boxes, pausing).options), PlannedStop)
  await runUnits([unit('u1'), unit('u2')], fanOut(boxes, ledger).options)
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/lane_0', 'run-1/lane_1'])
})

test('fanout: a lane whose kill failed is not used again', async () => {
  const { boxes, started } = fakeBoxes({ u1: ['hang'] })
  const failing: ScanBoxes = {
    ...boxes,
    async kill() {
      throw new Error('the kill RPC failed')
    },
  }
  await runUnits([unit('u1'), unit('u2')], fanOut(failing, memoryLedger(), { parallel: 1 }).options)
  assert.deepEqual(started.map((entry) => entry.slot), ['run-1/lane_0', 'run-1/u1-2', 'run-1/lane_1'])
})

test('fanout: a resume keeps a lane busy after an earlier attempt could not be killed', async () => {
  for (const kind of ['hang', 'start-error', 'poll-error'] as const) {
    for (const retryDone of [false, true]) {
      const { boxes, started, killed } = fakeBoxes({ u1: [kind] })
      const failing: ScanBoxes = {
        ...boxes,
        async kill(slot) {
          await boxes.kill(slot)
          throw new Error('the kill RPC failed')
        },
      }
      const ledger = memoryLedger()
      const pausing: Ledger = {
        get: ledger.get,
        put: ledger.put,
        safePoint(nextMs) {
          if (started.at(-1)?.slot === 'run-1/u1-2' && (retryDone ? nextMs === undefined : nextMs !== undefined))
            throw new PlannedStop('the call has no time left')
        },
      }
      const units = [unit('u1'), unit('u2')]
      await assert.rejects(runUnits(units, fanOut(failing, pausing, { parallel: 1 }).options), PlannedStop)
      const results = await runUnits(units, fanOut(failing, ledger).options)
      assert.deepEqual(results.map((result) => result.status), ['done', 'done'])
      assert.deepEqual(results.map((result) => result.attempts), [2, 1])
      assert.equal(started.at(-1)?.slot, 'run-1/lane_1')
      assert.deepEqual(killed, ['run-1/lane_0'])
    }
  }
})

test('fanout: a resume ends the compute entry at the end time of the job, not at the late poll', async () => {
  const { boxes } = fakeBoxes({})
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
  await assert.rejects(runUnits([unit('u1')], fanOut(boxes, pausing).options), PlannedStop)
  // The job ends 2 s after its start, and the host polls it again one hour later.
  const ending: ScanBoxes = {
    ...boxes,
    async poll(slot) {
      const polled = await boxes.poll(slot)
      return polled.state === 'done' ? { state: 'done', result: { ...polled.result, ended_at: 1_002_000 } } : polled
    },
  }
  const { options, clock } = fanOut(ending, ledger)
  clock.now += 3_600_000
  const [result] = await runUnits([unit('u1')], options)
  assert.equal(result?.status, 'done')
  assert.deepEqual(computeOf(ledger).map((row) => row.seconds), [2])
})

test('fanout: a lost job ends its compute entry at the last poll that saw it run', async () => {
  const { boxes } = fakeBoxes({})
  const ledger = memoryLedger()
  let polls = 0
  let kept: number | undefined
  // The job runs for 90 polls. Then the host is down for one hour, and the next poll finds no job.
  const losing: ScanBoxes = {
    ...boxes,
    maxUnitMs: 600_000,
    async poll(slot) {
      if (slot !== 'run-1/lane_0') return boxes.poll(slot)
      polls += 1
      if (polls <= 90) return { state: 'running' }
      kept = ledger.get<{ seenAt?: number }[]>(`attempts.unit.c0ffee.${'a'.repeat(64)}.u1`)?.[0]?.seenAt
      clock.now += 3_600_000
      return { state: 'missing' }
    },
  }
  const { options, clock } = fanOut(losing, ledger)
  const start = clock.now
  const [result] = await runUnits([{ ...unit('u1'), expected_seconds: 100 }], options)
  assert.equal(result?.status, 'done')
  assert.equal(computeOf(ledger)[0]?.seconds, 89)
  // The ledger keeps the last running poll at most once a minute, for a resume.
  assert.equal(kept, start + 60_000)
})

test('fanout: unit inputs give a symlink to a commit file as its bytes, and refuse other symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-fanout-'))
  mkdirSync(join(root, 'research'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'a')
  writeFileSync(join(root, 'research/holdout.json'), '[]')
  symlinkSync('a.txt', join(root, 'b.txt'))
  symlinkSync('../b.txt', join(root, 'sub/c.txt'))
  symlinkSync('research/holdout.json', join(root, 'holdout-link'))
  const files = await treeInputs(diskFileSystem(root), ['research/holdout.json'])
  assert.deepEqual(
    files.map((file) => [file.path, new TextDecoder().decode(file.data)]).sort(),
    [['a.txt', 'a'], ['b.txt', 'a'], ['sub/c.txt', 'a']],
  )
  symlinkSync('sub', join(root, 'data'))
  await assert.rejects(treeInputs(diskFileSystem(root), ['research/holdout.json']), /the symlink data,/)
})

test('fanout: fetched data replaces symlink aliases for each unit without changing the commit inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-fanout-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.csv'), 'old')
  symlinkSync('a.csv', join(root, 'b.csv'))
  symlinkSync('../b.csv', join(root, 'sub/c.csv'))
  const files = await treeInputs(diskFileSystem(root), [])
  const artifacts = memoryArtifacts()
  const put = (text: string) => artifacts.put(bytes(text), { source: { command: 'nb fetch' }, media_type: 'application/octet-stream' })
  const inputs = unitInputs(async () => files, {
    a: { 'a.csv': await put('new') },
    b: { 'b.csv': await put('alias') },
  }, artifacts)
  const contents = async (targets: string[]) =>
    (await inputs(unit('u1', targets))).map((file) => [file.path, new TextDecoder().decode(file.data)]).sort()
  assert.deepEqual(await contents(['a']), [['a.csv', 'new'], ['b.csv', 'new'], ['sub/c.csv', 'new']])
  assert.deepEqual(await contents(['a', 'b']), [['a.csv', 'new'], ['b.csv', 'alias'], ['sub/c.csv', 'alias']])
  assert.deepEqual(await contents([]), [['a.csv', 'old'], ['b.csv', 'old'], ['sub/c.csv', 'old']])
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
  const long = slotName('research.20261122 run', `${'x'.repeat(63)}y`, 3)
  assert.match(long, /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(long, slotName('research.20261122 run', `${'x'.repeat(63)}z`, 3))
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
