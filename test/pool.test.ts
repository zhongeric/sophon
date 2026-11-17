import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlannedStop } from '../src/core/planned-stop.ts'
import { pool } from '../src/core/pool.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a limit that is not an integer of 1 or more throws before any item starts', async () => {
  let calls = 0
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    await assert.rejects(
      pool([1, 2], limit, async () => calls++),
      /the pool limit must be an integer of 1 or more/,
      String(limit),
    )
  assert.equal(calls, 0)
})

test('no items give no results and no calls', async () => {
  let calls = 0
  assert.deepEqual(await pool([], 2, async () => calls++), [])
  assert.equal(calls, 0)
})

test('at most limit calls are in progress, and fewer items than the limit all start at the same time', async () => {
  let active = 0
  let most = 0
  const run = async (ms: number) => {
    active++
    most = Math.max(most, active)
    await sleep(ms)
    active--
    return ms
  }
  await pool([5, 1, 8, 3, 2, 7, 4, 6, 1, 2], 3, run)
  assert.equal(most, 3)

  let started = 0
  const running = pool([5, 5], 4, async (ms) => {
    started++
    await sleep(ms)
  })
  assert.equal(started, 2)
  await running
})

test('the results are in the order of the items when the items finish out of order', async () => {
  const finished: number[] = []
  const results = await pool([30, 0, 20, 10], 4, async (ms) => {
    await sleep(ms)
    finished.push(ms)
    return `done ${ms}`
  })
  assert.deepEqual(finished, [0, 10, 20, 30])
  assert.deepEqual(results, ['done 30', 'done 0', 'done 20', 'done 10'])
})

test('run gets the item and its index', async () => {
  assert.deepEqual(await pool(['a', 'b', 'c'], 2, async (item, index) => `${item}${index}`), ['a0', 'b1', 'c2'])
})

test('an error starts no new items, waits for the items in progress, and rejects with the first error', async () => {
  const started: number[] = []
  const settled: number[] = []
  const run = async (item: number) => {
    started.push(item)
    try {
      if (item === 0) return await sleep(30)
      if (item === 1) {
        await sleep(5)
        throw new Error('first')
      }
      if (item === 2) {
        await sleep(15)
        throw new Error('second')
      }
    } finally {
      settled.push(item)
    }
  }
  await assert.rejects(pool([0, 1, 2, 3, 4, 5], 3, run), { message: 'first' })
  assert.deepEqual(started, [0, 1, 2])
  assert.deepEqual(settled, [1, 2, 0])
  await sleep(40)
  assert.deepEqual(started, [0, 1, 2])
})

test('a real error replaces a PlannedStop as the failure, and the first real error still wins', async () => {
  const run = async ([ms, error]: [number, unknown]) => {
    await sleep(ms)
    throw error
  }
  const real = new Error('real')
  await assert.rejects(pool<[number, unknown], never>([[0, new PlannedStop('stop')], [10, real], [20, new Error('later')]], 3, run), real)
  await assert.rejects(pool<[number, unknown], never>([[0, new PlannedStop('one')], [10, new PlannedStop('two')]], 2, run), { message: 'one' })
})
