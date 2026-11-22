import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { cleanBox, type Box, type BoxResult, type JobState } from '../src/cloudflare/box.ts'
import { jobRunner, resetJobStarts, type JobRecord } from '../src/cloudflare/jobs.ts'
import type { Ledger } from '../src/core/ledger.ts'
import { PausedError } from '../src/core/questions.ts'

/** A ledger in memory. A value goes through JSON, as in Durable Object SQL. */
function memoryLedger(): Ledger {
  const state = new Map<string, unknown>()
  return { get: <T>(key: string) => state.get(key) as T | undefined, put: (key, value) => void state.set(key, JSON.parse(JSON.stringify(value))) }
}

/**
 * A machine whose jobs the test controls: a job runs until the test sets its state, and each start and kill is in
 * `events`. A start also keeps the ledger record of the job at that time. Other commands run in a local directory.
 */
function fakeBox(ledger: Ledger) {
  const root = mkdtempSync(join(tmpdir(), 'factory-jobs-'))
  const states = new Map<string, JobState>()
  const events: string[] = []
  const recorded: (JobRecord | undefined)[] = []
  const box: Box = {
    async start() {},
    async exec(argv, { cwd, stdin }) {
      events.push(`exec ${argv.join(' ')}`)
      mkdirSync(join(root, cwd), { recursive: true })
      const result = spawnSync(argv[0]!, argv.slice(1), { cwd: join(root, cwd), input: stdin ? Buffer.from(stdin) : undefined })
      return { exit_code: result.status, output: `${result.stdout}${result.stderr}` }
    },
    async startJob(id, argv, { cwd }) {
      events.push(`start ${cwd} ${argv.join(' ')}`)
      recorded.push(ledger.get<JobRecord>(`job:${id}`))
      states.set(id, { state: 'running' })
    },
    async pollJob(id) {
      return states.get(id) ?? { state: 'missing' }
    },
    async killJob(id) {
      events.push(`kill ${id}`)
      states.delete(id)
    },
  }
  return { box, events, recorded, root, states }
}

/** A clock that each sleep moves forward, and a hook that runs after each sleep. */
function clock() {
  const time = { now: 0, sleeps: 0, after: () => {} }
  const options = {
    now: () => time.now,
    sleep: async (ms: number) => {
      time.now += ms
      time.sleeps += 1
      time.after()
    },
  }
  return { options, time }
}

const make = ['bash', '-c', 'make']
const done: BoxResult = { exit_code: 0, output: 'built' }
const pauseOptions = (deadline: number) => ({ cwd: 'clean/1', deadline, env: {}, timeoutMs: 60_000 })
const pauses = (error: unknown) => error instanceof PausedError && error.message === 'waiting for the job `bash -c make` in clean/1'
const open = (ledger: Ledger) => ledger.get<string[]>('jobs:open')

test('a pause job is in the ledger before it starts, and a later call gives its stored result without a new run', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const { options, time } = clock()
  time.after = () => {
    if (time.sleeps === 3) fake.states.set([...fake.states.keys()][0]!, { result: done, state: 'done' })
  }
  assert.deepEqual(await jobRunner(fake.box, ledger, options).pause('clean/1:make', make, pauseOptions(60_000)), done)
  const [record] = fake.recorded
  assert.deepEqual(record && { ...record, call: '', id: '' }, { argv: make, call: '', cwd: 'clean/1', id: '', mode: 'pause', state: 'open' })
  assert.deepEqual(ledger.get<JobRecord>(`job:${record?.id}`)?.result, done)
  assert.deepEqual(open(ledger), [])

  fake.states.clear()
  assert.deepEqual(await jobRunner(fake.box, ledger, clock().options).pause('clean/1:make', make, pauseOptions(60_000)), done)
  assert.deepEqual(fake.events, ['start clean/1 bash -c make'])
})

test('a pause job throws a PausedError at the deadline, and a replay with a new runner polls it and does not start it again', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const first = clock()
  await assert.rejects(jobRunner(fake.box, ledger, first.options).pause('clean/1:make', make, pauseOptions(10_000)), pauses)
  assert.equal(first.time.now, 10_000)
  assert.ok(first.time.sleeps > 1)
  assert.equal(open(ledger)?.length, 1)

  // A call that starts after its deadline still polls the job one time.
  await assert.rejects(jobRunner(fake.box, ledger, clock().options).pause('clean/1:make', make, pauseOptions(0)), pauses)
  const replay = clock()
  replay.time.after = () => fake.states.set(open(ledger)![0]!, { result: done, state: 'done' })
  assert.deepEqual(await jobRunner(fake.box, ledger, replay.options).pause('clean/1:make', make, pauseOptions(60_000)), done)
  assert.deepEqual(fake.events, ['start clean/1 bash -c make'])
  assert.deepEqual(open(ledger), [])
})

test('a recorded pause job that the machine does not have starts again after a kill', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  await assert.rejects(jobRunner(fake.box, ledger, clock().options).pause('clean/1:make', make, pauseOptions(0)), pauses)
  const [old] = open(ledger) ?? []
  // A new machine, for example: the job is gone.
  fake.states.clear()
  await assert.rejects(jobRunner(fake.box, ledger, clock().options).pause('clean/1:make', make, pauseOptions(0)), pauses)
  const [next] = open(ledger) ?? []
  assert.notEqual(next, old)
  assert.deepEqual(fake.events, ['start clean/1 bash -c make', `kill ${old}`, 'start clean/1 bash -c make'])
  assert.equal(ledger.get<JobRecord>(`job:${old}`)?.state, 'killed')
})

test('a lost pause job stops after three starts across copies until an administrator error resume resets its budget', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const call = (copy: number) => jobRunner(fake.box, ledger, clock().options).pause(`clean/1@${copy}:make`, make, pauseOptions(0))
  for (const copy of [1, 1, 2]) {
    await assert.rejects(call(copy), pauses)
    fake.states.clear()
  }
  for (const copy of [2, 3, 4]) {
    await assert.rejects(call(copy), /the machine lost the job `bash -c make` in clean\/1 3 times/)
  }
  assert.equal(fake.events.filter((event) => event.startsWith('start')).length, 3)

  await jobRunner(fake.box, ledger, clock().options).killAll()
  resetJobStarts(ledger)
  const replay = clock()
  replay.time.after = () => {
    for (const id of fake.states.keys()) fake.states.set(id, { result: done, state: 'done' })
  }
  assert.deepEqual(await jobRunner(fake.box, ledger, replay.options).pause('clean/1@4:make', make, pauseOptions(60_000)), done)
  assert.equal(fake.events.filter((event) => event.startsWith('start')).length, 4)
  assert.deepEqual(open(ledger), [])
})

test('a wait job polls until its end, and the next call kills the wait jobs of earlier calls only', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const quick = clock()
  quick.time.after = () => fake.states.set(open(ledger)![0]!, { result: done, state: 'done' })
  assert.deepEqual(await jobRunner(fake.box, ledger, quick.options).wait(make, { cwd: 'work/x', env: {}, timeoutMs: 60_000 }), done)
  assert.deepEqual(open(ledger), [])

  // The jobs of a call that died: a wait job of a turn, and a pause job of a host step.
  const never = { now: () => 0, sleep: () => new Promise<void>(() => {}) }
  const died = jobRunner(fake.box, ledger, never)
  void died.wait(['bash', '-c', 'npm test'], { cwd: 'work/x', env: {}, timeoutMs: 60_000 })
  await assert.rejects(died.pause('clean/1:make', make, pauseOptions(0)), pauses)
  const [turn, step] = open(ledger) ?? []
  const next = jobRunner(fake.box, ledger, never)
  void next.wait(['bash', '-c', 'npm run check'], { cwd: 'work/x', env: {}, timeoutMs: 60_000 })
  const [, , own] = open(ledger) ?? []

  await next.killStale()
  assert.deepEqual(open(ledger), [step, own])
  assert.equal(ledger.get<JobRecord>(`job:${turn}`)?.state, 'killed')
  assert.equal(fake.events.at(-1), `kill ${turn}`)
  await next.killAll()
  assert.deepEqual(open(ledger), [])
  assert.deepEqual(fake.events.slice(-2), [`kill ${step}`, `kill ${own}`])
})

test('a wait job that the machine does not have fails the call', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const lost = clock()
  lost.time.after = () => fake.states.clear()
  await assert.rejects(jobRunner(fake.box, ledger, lost.options).wait(make, { cwd: 'work/x', env: {}, timeoutMs: 60_000 }), /the job `bash -c make` in work\/x is not in the machine/)
  assert.deepEqual(open(ledger), [])
})

test('a clean box keeps its directory when the ledger and the marker agree, and copies the tree again without the marker', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a' } })
  const lines: string[] = []
  const dir = join(fake.root, 'clean/1')
  const marker = join(fake.root, 'clean/1.sync')
  const copies: string[] = []
  /** One alarm call: the clean box of the step key, and its command. Each job ends at the first sleep. */
  const run = async () => {
    const { options, time } = clock()
    time.after = () => {
      for (const [id, state] of fake.states) if (state.state === 'running') fake.states.set(id, { result: done, state: 'done' })
    }
    const runner = jobRunner(fake.box, ledger, options)
    const box = await cleanBox(fake.box, tree, 'clean/1', (line) => lines.push(line), { deadline: 60_000, key: 'calibrate.h1.1', ledger, runner })
    copies.push(box.id)
    return box.run('make', { env: [], timeoutMs: 60_000 })
  }

  assert.deepEqual(await run(), done)
  const copy = ledger.get<string>('clean-box:calibrate.h1.1')
  assert.equal(readFileSync(marker, 'utf8'), copy)
  assert.match(lines.at(-1) ?? '', /^sync clean\/1: full, 1 files sent in \d+ ms$/)
  writeFileSync(join(dir, 'out.txt'), 'output of make')

  // A replay: the same directory, its output, and the stored result of the command.
  const before = fake.events.length
  assert.deepEqual(await run(), done)
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8'), 'output of make')
  assert.equal(copies[1], copies[0])
  assert.equal(fake.events.slice(before).some((event) => event.includes('rm -rf') || event.startsWith('start')), false)
  assert.match(lines.at(-1) ?? '', /^sync clean\/1: kept, 0 files sent in \d+ ms$/)

  // A new machine has no marker: a new copy, and the command runs again in it.
  rmSync(marker)
  assert.deepEqual(await run(), done)
  assert.notEqual(copies[2], copies[0])
  assert.equal(existsSync(join(dir, 'out.txt')), false)
  assert.notEqual(ledger.get<string>('clean-box:calibrate.h1.1'), copy)
  assert.equal(fake.events.filter((event) => event === 'start clean/1 bash -c make').length, 2)
  assert.match(lines.at(-1) ?? '', /^sync clean\/1: full, 1 files sent in \d+ ms$/)
})

test('a clean box gives the end time of its last job, also after a pause', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a' } })
  const open = (deadline: number) => {
    const runner = jobRunner(fake.box, ledger, clock().options)
    return cleanBox(fake.box, tree, 'clean/1', () => {}, { deadline, key: 'calibrate.h1.1', ledger, runner })
  }
  const first = await open(0)
  await assert.rejects(first.run('make', { env: [], timeoutMs: 60_000 }), PausedError)
  assert.equal(first.endedAt(), undefined)
  // The job ends during the pause, and the next call polls it later.
  for (const id of fake.states.keys()) fake.states.set(id, { result: { ...done, ended_at: 5_000 }, state: 'done' })
  const second = await open(60_000)
  assert.deepEqual(await second.run('make', { env: [], timeoutMs: 60_000 }), { ...done, ended_at: 5_000 })
  assert.equal(second.endedAt(), 5_000)
})

test('a wait job ends by the deadline of the runner, and no job starts with less than a second left', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const timeouts: number[] = []
  const box: Box = {
    ...fake.box,
    async startJob(id, argv, options) {
      timeouts.push(options.timeoutMs)
      await fake.box.startJob(id, argv, options)
    },
  }
  const { options, time } = clock()
  time.now = 100_000
  time.after = () => {
    for (const id of fake.states.keys()) fake.states.set(id, { result: done, state: 'done' })
  }
  const runner = jobRunner(box, ledger, { ...options, deadline: 130_000 })
  const wait = { cwd: 'work/a', env: {}, timeoutMs: 600_000 }
  assert.deepEqual(await runner.wait(make, wait), done)
  assert.deepEqual(timeouts, [30_000])
  time.now = 129_500
  assert.deepEqual(await runner.wait(make, wait), { exit_code: null, output: '[host] not started: the alarm call has no time left for this command' })
  assert.deepEqual(timeouts, [30_000])
  // Without a deadline, the job keeps its own timeout.
  assert.deepEqual(await jobRunner(box, ledger, options).wait(make, wait), done)
  assert.deepEqual(timeouts, [30_000, 600_000])
})

test('an injected uuid gives the call ID and the job IDs, and the default gives random UUIDs', async () => {
  const ledger = memoryLedger()
  const fake = fakeBox(ledger)
  const { options, time } = clock()
  time.after = () => {
    for (const id of fake.states.keys()) fake.states.set(id, { result: done, state: 'done' })
  }
  let count = 0
  const runner = jobRunner(fake.box, ledger, { ...options, uuid: () => `id-${++count}` })
  const wait = { cwd: 'work/a', env: {}, timeoutMs: 60_000 }
  assert.deepEqual(await runner.wait(make, wait), done)
  assert.deepEqual(await runner.wait(make, wait), done)
  assert.deepEqual(
    fake.recorded.map((record) => record && { call: record.call, id: record.id }),
    [
      { call: 'id-1', id: 'job-id-2' },
      { call: 'id-1', id: 'job-id-3' },
    ],
  )

  fake.recorded.length = 0
  assert.deepEqual(await jobRunner(fake.box, ledger, options).wait(make, wait), done)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const [record] = fake.recorded
  assert.match(record?.call ?? '', uuid)
  assert.match(record?.id.slice('job-'.length) ?? '', uuid)
})
