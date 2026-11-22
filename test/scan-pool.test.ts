import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JobState } from '../src/cloudflare/box.ts'
import { scanPool, standard4, type ScanSlotStub } from '../src/cloudflare/scan-pool.ts'
import { maxUnitMs, type Unit } from '../src/cloudflare/scan-slot.ts'

/** A SCAN_BOXES namespace whose objects record each call with the name of the object, and fail the start with `startError`. */
function fakeNamespace(startError?: Error) {
  const calls: { object: string; method: string; args: unknown[] }[] = []
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get({ name: object }: { name: string }): ScanSlotStub {
      return {
        async start(name: string, unit: Unit) {
          calls.push({ args: [name, unit], method: 'start', object })
          if (startError) throw startError
          return { job: `job-${name}` }
        },
        async poll(name: string): Promise<JobState> {
          calls.push({ args: [name], method: 'poll', object })
          return { result: { exit_code: 0, output: 'ok' }, state: 'done' }
        },
        async kill(name: string) {
          calls.push({ args: [name], method: 'kill', object })
        },
        async read(name: string, path: string) {
          calls.push({ args: [name, path], method: 'read', object })
          return new TextEncoder().encode(path)
        },
      }
    },
  }
  return { calls, namespace }
}

test('scan pool: each call goes to the object of its slot, and the command runs as bash -c', async () => {
  const { calls, namespace } = fakeNamespace()
  const pool = scanPool(namespace)
  const inputs = [{ data: new Uint8Array([1]), path: 'data/a.bin' }]

  assert.deepEqual(await pool.start('run-1/u1-1', { command: 'echo "$x"', inputs, timeoutMs: 60_000 }), { job: 'job-run-1/u1-1' })
  assert.deepEqual(await pool.poll('run-1/u2-1'), { result: { exit_code: 0, output: 'ok' }, state: 'done' })
  await pool.kill('run-1/u1-1')
  assert.deepEqual(await pool.read('run-1/u2-1', 'out/x.json'), new TextEncoder().encode('out/x.json'))

  assert.deepEqual(calls, [
    { args: ['run-1/u1-1', { argv: ['bash', '-c', 'echo "$x"'], inputs, timeoutMs: 60_000 }], method: 'start', object: 'run-1/u1-1' },
    { args: ['run-1/u2-1'], method: 'poll', object: 'run-1/u2-1' },
    { args: ['run-1/u1-1'], method: 'kill', object: 'run-1/u1-1' },
    { args: ['run-1/u2-1', 'out/x.json'], method: 'read', object: 'run-1/u2-1' },
  ])
})

test('scan pool: a start that the container capacity refuses is full, and other start errors go to the caller', async () => {
  const full = scanPool(fakeNamespace(new Error('there is no Container instance that can be provided to this Durable Object, try again later')).namespace)
  assert.deepEqual(await full.start('run-1/u1-1', { command: 'true', inputs: [], timeoutMs: 1_000 }), { full: true })

  const lost = scanPool(fakeNamespace(new Error('the copy of the inputs to scan/run-1/u1-1 failed: disk full')).namespace)
  await assert.rejects(lost.start('run-1/u1-1', { command: 'true', inputs: [], timeoutMs: 1_000 }), /the copy of the inputs/)
})

test('scan pool: a box is a standard-4 with the unit limit of a scan slot', () => {
  const pool = scanPool(fakeNamespace().namespace)
  assert.deepEqual(pool.instance, { gib: 12, type: 'standard-4', vcpu: 4 })
  assert.equal(pool.instance, standard4)
  assert.equal(pool.maxUnitMs, maxUnitMs)
  assert.ok(pool.pollMs >= 1_000 && pool.pollMs <= 10_000)
})

test('scan pool: the slots have no egress, so an egress job is refused before a call, and a unit job carries no egress', async () => {
  const { calls, namespace } = fakeNamespace()
  const pool = scanPool(namespace)
  assert.equal(pool.egress, false)
  await assert.rejects(pool.start('run-1-fetch/t_1-1', { command: 'fetch', inputs: [], timeoutMs: 1_000, egress: true }), /have no egress, so the job of run-1-fetch\/t_1-1 cannot start/)
  assert.deepEqual(calls, [])
  await pool.start('run-1-sweep/u1-1', { command: 'unit', inputs: [], timeoutMs: 1_000 })
  assert.deepEqual(calls, [{ args: ['run-1-sweep/u1-1', { argv: ['bash', '-c', 'unit'], inputs: [], timeoutMs: 1_000 }], method: 'start', object: 'run-1-sweep/u1-1' }])
})
