import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { failureMessage, schedule, violations, type Trace } from './support/simulation.ts'

/**
 * The seeds that found a bug of the engine. They run each time, also when SIM_SEEDS is small. Add the seed of each
 * bug that the simulation finds, with the bug that it found.
 */
const bugSeeds: number[] = []

/** A positive integer from the environment, or the default when the variable is not set. */
function positive(name: string, fallback: number | undefined): number | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer, not ${JSON.stringify(value)}`)
  return Number(value)
}

const only = positive('SIM_SEED', undefined)
const count = positive('SIM_SEEDS', 200) ?? 200
const seeds = only !== undefined ? [only] : [...new Set([...Array.from({ length: count }, (_, index) => index + 1), ...bugSeeds])]

const base: Trace = {
  calls: 10,
  comments: [{ body: 'Run passed', issue: 7 }],
  commits: { 'refs/heads/main': ['t1 base'] },
  counts: { box: 3, github: 5, job: 1, model: 4, storage: 20 },
  errors: [],
  faults: [],
  kind: 'review',
  limit: 40,
  note: '',
  posts: [
    { body: 'Run started', issue: 7 },
    { body: 'Run passed', issue: 7 },
    { body: 'Run passed', issue: 5 },
  ],
  report: '- Alarm calls: 0 planned stops, 0 crash restarts\n| reviewer | model | 1 | 2 | 3 | 4 | $0.01 |',
  seed: 0,
  state: 'passed',
  steps: ['review a step:one', 'review a step:two'],
}

test('the invariant checks pass a trace that matches the reference', () => {
  assert.deepEqual(violations(base, base), [])
})

test('the invariant checks ignore the restart counters and the usage figures', () => {
  const trace = { ...base, report: '- Alarm calls: 2 planned stops, 1 crash restart\n| reviewer | model | 5 | 6 | 7 | 8 | $0.02 |' }
  assert.deepEqual(violations(trace, base), [])
})

test('the invariant checks ignore the order of the usage rows', () => {
  const report = '| a | m | 1 | 0 | 0 | 1 | $0.01 |\n| b | m | 1 | 0 | 0 | 1 | $0.01 |\n| **Total** |  | 2 | 0 | 0 | 2 | $0.02 |'
  const swapped = '| b | m | 1 | 0 | 0 | 1 | $0.01 |\n| a | m | 1 | 0 | 0 | 1 | $0.01 |\n| **Total** |  | 2 | 0 | 0 | 2 | $0.02 |'
  assert.deepEqual(violations({ ...base, report: swapped }, { ...base, report }), [])
  assert.equal(violations({ ...base, report: report.replace('| a |', '| c |') }, { ...base, report }).length, 1)
})

test('the invariant checks find each kind of violation', () => {
  const cases: [Partial<Trace>, RegExp][] = [
    [{ state: 'running' }, /^no end: the run is running after 10 alarm calls \(limit 40\)$/],
    [{ note: 'boom', state: 'error' }, /^the run waits with error: boom$/],
    [{ steps: ['review a step:one', 'review a step:one'] }, /^the step review a step:one finished two times$/],
    [{ posts: [...base.posts, { body: 'Run started', issue: 7 }] }, /^a new comment on #7 repeats an earlier comment/],
    [{ commits: { 'refs/heads/main': ['t2 base'] } }, /^the commits differ from the reference/],
    [{ comments: [] }, /^the comments differ from the reference/],
    [{ report: 'other' }, /^the report lines differ from the reference/],
    [{ errors: ['the alarm of x threw: y'] }, /^the alarm of x threw: y$/],
  ]
  for (const [change, expected] of cases) {
    const found = violations({ ...base, ...change }, base)
    assert.equal(found.length, 1, JSON.stringify({ change, found }))
    assert.match(found[0]!, expected)
  }
})

test('a failure message gives the seed, the faults and the command that runs only this seed', () => {
  const message = failureMessage({ faults: [{ at: 3, kind: 'die-github' }], kind: 'develop', seed: 42 }, ['no end'])
  assert.match(message, /^seed 42 \(develop run\) failed$/m)
  assert.match(message, /^faults: \[\{"at":3,"kind":"die-github"\}\]$/m)
  assert.match(message, /^- no end$/m)
  assert.match(message, /^rerun: SIM_SEED=42 node --test test\/simulation\.test\.ts$/m)
})

test('a seed gives the same fault schedule each time', () => {
  const counts = { box: 30, github: 50, job: 5, model: 20, storage: 400 }
  for (let seed = 1; seed <= 50; seed++) assert.deepEqual(schedule(seed, counts), schedule(seed, counts))
  assert.ok(Array.from({ length: 50 }, (_, index) => schedule(index + 1, counts)).some((faults) => faults.length > 0))
})

/** Runs a share of the seeds in a worker thread. Resolves with the failure messages. */
function runShare(share: number[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const failures: string[] = []
    const worker = new Worker(new URL('./support/simulation-worker.ts', import.meta.url), { workerData: share })
    worker.on('message', (result: { failure: string | null }) => void (result.failure && failures.push(result.failure)))
    worker.on('error', reject)
    worker.on('exit', (code) => (code === 0 ? resolve(failures) : reject(new Error(`a simulation worker ended with exit code ${code}`))))
  })
}

test(`the runs keep their invariants under the faults of ${seeds.length} seeds`, async () => {
  // The seeds run in worker threads, so that 200 seeds take less than 30 s.
  const threads = Math.max(1, Math.min(availableParallelism(), 8, seeds.length))
  const shares = Array.from({ length: threads }, (_, thread) => seeds.filter((_, index) => index % threads === thread))
  const failures = (await Promise.all(shares.map(runShare))).flat()
  assert.equal(failures.length, 0, `${failures.length} of ${seeds.length} seeds failed\n\n${failures.slice(0, 5).join('\n\n')}`)
})
