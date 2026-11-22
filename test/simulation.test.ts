import assert from 'node:assert/strict'
import { availableParallelism } from 'node:os'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { failureMessage, kindOf, schedule, simulate, violations, type Trace } from './support/simulation.ts'

/**
 * The seeds that found a bug of the engine. They run each time, also when SIM_SEEDS is small. Add the seed of each
 * bug that the simulation finds, with the bug that it found.
 */
const bugSeeds: number[] = []

/** A positive integer from the environment, or the default when the variable is not set. */
function positive<T extends number | undefined>(name: string, fallback: T): number | T {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer, not ${JSON.stringify(value)}`)
  return Number(value)
}

const only = positive('SIM_SEED', undefined)
const count = positive('SIM_SEEDS', 200)
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
    [{ posts: [base.posts[0]!, { body: 'Run failed', issue: 7 }, base.posts[2]!] }, /^the posts differ from the reference/],
    [{ posts: base.posts.slice(0, 2) }, /^the posts differ from the reference/],
    [{ report: 'other' }, /^the report lines differ from the reference/],
    [{ errors: ['the alarm of x threw: y'] }, /^the alarm of x threw: y$/],
  ]
  for (const [change, expected] of cases) {
    const found = violations({ ...base, ...change }, base)
    assert.equal(found.length, 1, JSON.stringify({ change, found }))
    assert.match(found[0]!, expected)
  }
})

test('the commits check compares the trees, also when they are real 40-hex IDs', () => {
  const reference = { ...base, commits: { 'refs/heads/main': [`${'a'.repeat(40)} base`] } }
  const found = violations({ ...base, commits: { 'refs/heads/main': [`${'b'.repeat(40)} base`] } }, reference)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.match(found[0]!, /^the commits differ from the reference/)
  assert.deepEqual(violations(reference, reference), [])
})

test('the invariant checks fail a reference run that does not pass', () => {
  for (const state of ['error', 'failed', 'running']) {
    const reference = { ...base, note: 'boom', state }
    assert.ok(violations(reference, reference).some((line) => line.startsWith(`the reference run ended ${state}, not passed: boom`)), state)
  }
})

test('a failure message gives the seed, the faults and the command that runs only this seed', () => {
  const message = failureMessage({ faults: [{ at: 3, kind: 'die-github' }], kind: 'develop', seed: 42 }, ['no end'])
  assert.match(message, /^seed 42 \(develop run\) failed$/m)
  assert.match(message, /^faults: \[\{"at":3,"kind":"die-github"\}\]$/m)
  assert.match(message, /^- no end$/m)
  assert.match(message, /^rerun: SIM_SEED=42 node --test test\/simulation\.test\.ts$/m)
})

test('some seeds get faults', () => {
  const counts = { box: 30, github: 50, job: 5, model: 20, storage: 400 }
  assert.ok(Array.from({ length: 50 }, (_, index) => schedule(index + 1, counts)).some((faults) => faults.length > 0))
})

test('a simulation with the same seed and faults gives the same counts, steps and posts', async () => {
  const faults: Parameters<typeof simulate>[2] = [
    { at: 2, kind: 'die-model' },
    { at: 6, kind: 'github-429' },
  ]
  const first = await simulate(1, 'review', faults, 200)
  const second = await simulate(1, 'review', faults, 200)
  assert.equal(first.state, 'passed', first.note)
  assert.deepEqual(second.counts, first.counts)
  assert.deepEqual(second.steps, first.steps)
  assert.deepEqual(second.posts, first.posts)
})

/** The most wall time of one seed, with the reference runs of its worker. A seed that uses more hangs. */
const seedLimit = 120_000

/**
 * Runs a share of the seeds in a worker thread. Resolves with the failure messages. If a seed hangs or throws, the
 * failure names the seed after the last result.
 */
function runShare(share: number[]): Promise<string[]> {
  return new Promise((resolve) => {
    const failures: string[] = []
    let done = 0
    let ended = false
    const worker = new Worker(new URL('./support/simulation-worker.ts', import.meta.url), { workerData: share })
    const end = (problem?: string) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      const seed = share[done]
      if (problem !== undefined && seed === undefined) failures.push(`a simulation worker failed after its last seed: ${problem}`)
      // The fault schedule of a seed comes from the reference run in the worker, so it is not known here.
      else if (problem !== undefined && seed !== undefined) failures.push(failureMessage({ faults: [], kind: kindOf(seed), seed }, [problem]))
      void worker.terminate()
      resolve(failures)
    }
    const arm = () => setTimeout(() => end(`the seed did not end in ${seedLimit / 1000} s`), seedLimit)
    let timer = arm()
    worker.on('message', (result: { failure: string | null }) => {
      if (ended) return
      done++
      if (result.failure) failures.push(result.failure)
      clearTimeout(timer)
      timer = arm()
    })
    worker.on('error', (error) => end(`the seed threw: ${String(error)}`))
    worker.on('exit', (code) => end(code === 0 && done === share.length ? undefined : `the worker ended with exit code ${code}`))
  })
}

test(`the runs keep their invariants under the faults of ${seeds.length} seeds`, async () => {
  // The seeds run in worker threads. With 4 threads, 200 seeds took 22 s. The mock GitHub reads refs and writes repeated git objects without git processes.
  const threads = Math.max(1, Math.min(availableParallelism(), 8, seeds.length))
  const shares = Array.from({ length: threads }, (_, thread) => seeds.filter((_, index) => index % threads === thread))
  const failures = (await Promise.all(shares.map(runShare))).flat()
  assert.equal(failures.length, 0, `${failures.length} of ${seeds.length} seeds failed\n\n${failures.slice(0, 5).join('\n\n')}`)
})
