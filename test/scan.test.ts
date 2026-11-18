import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { containerBox, type Box, type BoxResult } from '../src/cloudflare/box.ts'
import { maxUnitMs, scanSlot, slotInactivityMs, type SlotState, type SlotStore, type Unit } from '../src/cloudflare/scan-slot.ts'
import { artifactSizeLimit } from '../src/core/artifacts.ts'
import { localContainer } from './support/container.ts'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

function gate() {
  let open = () => {}
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { open, wait }
}

function memoryStore(initial: SlotState | null = null): SlotStore {
  let state = initial
  return { read: () => state, save: (next) => void (state = next) }
}

/** A scan slot over a local container, with the inactivity timeout of a scan box. */
function slotFixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-scan-'))
  const container = localContainer(root)
  const store = memoryStore()
  const box = containerBox(container, { enableInternet: false, inactivityMs: () => slotInactivityMs(store.read()), onStart: () => {} })
  return { box, container, dir: join(root, 'scan/pool-1/slot-1'), root, slot: scanSlot(box, store, 'pool-1/slot-1'), store }
}

/** Polls the job of the last unit until it ends, for at most 10 s. */
async function finished(slot: ReturnType<typeof scanSlot>): Promise<BoxResult> {
  for (let polls = 0; polls < 100; polls++) {
    const polled = await slot.poll()
    if (polled.state === 'done') return polled.result
    assert.equal(polled.state, 'running')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the job did not end in 10 s')
}

const quick: Unit = { argv: ['true'], inputs: [], timeoutMs: 60_000 }

test('a scan box starts its container with no network, and its inactivity timeout covers the time limit of the job', async () => {
  const { container, slot } = slotFixture()
  const limit = 2 * 60 * 60_000
  await slot.start({ argv: ['bash', '-c', 'cat in.txt; printf " %s %s" "$NUMBA_CACHE_DIR" "$NUMBA_CPU_NAME"'], inputs: [{ data: encode('in'), path: 'in.txt' }], timeoutMs: limit })
  assert.deepEqual(container.starts, [{ enableInternet: false }])
  // The start of the job renews the timeout with the new time limit, and no poll comes before the end of the job.
  assert.ok((container.timeouts.at(-1) ?? 0) > limit, String(container.timeouts))
  assert.deepEqual(await finished(slot), { exit_code: 0, output: 'in /opt/numba-cache generic' })

  // A build box keeps the network and its fixed timeout.
  const build = localContainer(mkdtempSync(join(tmpdir(), 'factory-scan-')))
  await containerBox(build, { inactivityMs: 60_000, onStart: () => {} }).start()
  assert.deepEqual([build.starts, build.timeouts], [[{ enableInternet: true }], [60_000]])
})

test('a scan box refuses a second unit while the job of its last unit runs', async () => {
  const { slot, store } = slotFixture()
  const { job } = await slot.start({ ...quick, argv: ['sleep', '30'] })
  assert.deepEqual(await slot.poll(), { state: 'running' })
  await assert.rejects(slot.start(quick), new RegExp(`the slot pool-1/slot-1 still runs the job ${job.replace(/\./g, '\\.')}`))
  assert.equal(store.read()?.job, job)
  await slot.kill()
  const next = await slot.start(quick)
  assert.notEqual(next.job, job)
  assert.equal((await finished(slot)).exit_code, 0)
})

test('a scan box refuses a second unit while the first unit starts', async () => {
  const { box, store } = slotFixture()
  // Two objects of one slot share the store, as two RPC calls to one Durable Object do.
  const [first, second] = [scanSlot(box, store, 'pool-1/slot-1'), scanSlot(box, store, 'pool-1/slot-1')]
  const unit = { ...quick, argv: ['sleep', '30'] }
  const results = await Promise.allSettled([first.start(unit), second.start(unit)])
  const refused = results.filter((result) => result.status === 'rejected')
  assert.equal(refused.length, 1)
  assert.match(String(refused[0]?.reason), /the slot pool-1\/slot-1 already starts a unit/)
  assert.deepEqual(await first.poll(), { state: 'running' })
  await first.kill()
  assert.notEqual((await first.poll()).state, 'running')
})

for (const failStart of [false, true]) {
  test(`a kill waits for pgid and cleanup when the pending start ${failStart ? 'fails' : 'succeeds'}`, async () => {
    const entered = gate()
    const publish = gate()
    const cleaning = gate()
    const cleaned = gate()
    let directory = false
    let pgid = false
    let running = false
    let starts = 0
    const kills: string[] = []
    const box: Box = {
      async start() {},
      async exec() { return { exit_code: 0, output: '' } },
      async startJob() {
        starts++
        directory = true
        pgid = false
        running = true
        entered.open()
        // The command runs before the wrapper publishes its process groups.
        await publish.wait
        if (!directory) throw new Error('the job directory disappeared before pgid')
        pgid = true
        if (failStart && starts === 1) throw new Error('startup failed')
      },
      async pollJob() { return { state: directory && pgid && running ? 'running' : 'missing' } },
      async killJob(id) {
        kills.push(id)
        cleaning.open()
        await cleaned.wait
        if (pgid) running = false
        directory = false
      },
    }
    const store = memoryStore()
    const first = scanSlot(box, store, 'pool-1/slot-1')
    const second = scanSlot(box, store, 'pool-1/slot-1')
    const started = first.start(quick)
    const result = failStart ? assert.rejects(started, /startup failed/) : started
    await entered.wait
    let killDone = false
    const killed = second.kill().then(() => { killDone = true })
    const settled = Promise.all([result, killed])
    try {
      await assert.rejects(second.start(quick), /already starts a unit/)
      assert.deepEqual(kills, [])
      assert.equal(killDone, false)
      publish.open()
      await cleaning.wait
      assert.equal(pgid, true)
      assert.equal(running, true)
      assert.equal(killDone, false)
      await assert.rejects(second.start(quick), /already starts a unit/)
      cleaned.open()
      await settled
      assert.deepEqual(kills, [store.read()?.job])
      assert.equal(running, false)
      assert.deepEqual(await second.poll(), { state: 'missing' })
      await second.start(quick)
      await second.kill()
      assert.equal(running, false)
    } finally {
      publish.open()
      cleaned.open()
      await Promise.allSettled([settled])
    }
  })
}

test('each unit starts in a clean unit directory, and the slot keeps only the outputs of its last unit', async () => {
  const { dir, root, slot } = slotFixture()
  const binary = Uint8Array.from({ length: 256 }, (_, index) => index)
  const first = await slot.start({ ...quick, argv: ['cp', 'in/a.bin', 'a.out'], inputs: [{ data: binary, path: 'in/a.bin' }] })
  assert.equal((await finished(slot)).exit_code, 0)
  assert.deepEqual(await slot.read('a.out'), binary)

  await slot.start({ ...quick, argv: ['cp', 'b.txt', 'b.out'], inputs: [{ data: encode('b'), path: 'b.txt' }] })
  assert.equal((await finished(slot)).exit_code, 0)
  assert.deepEqual(readdirSync(dir).sort(), ['b.out', 'b.txt'])
  assert.equal(decode(await slot.read('b.out')), 'b')
  await assert.rejects(slot.read('a.out'), /read a\.out: no such file in scan\/pool-1\/slot-1/)
  // The job of the last unit is gone too.
  assert.equal(existsSync(join(root, 'jobs', first.job)), false)
})

test('a scan slot refuses bad names, units and paths before it calls the box', async () => {
  const calls: string[] = []
  const refuse = (method: string) => async () => {
    calls.push(method)
    throw new Error('the box got a call')
  }
  const box: Box = { exec: refuse('exec'), killJob: refuse('killJob'), pollJob: refuse('pollJob'), start: refuse('start'), startJob: refuse('startJob') }
  for (const name of ['pool-1', 'pool-1/slot-1/x', '../slot-1', 'pool-1/', '/slot-1', 'pool 1/slot-1', 'pool.1/slot-1']) {
    assert.throws(() => scanSlot(box, memoryStore(), name), /the slot name .* is not <pool>\/<slot>/)
  }
  const slot = scanSlot(box, memoryStore(), 'pool-1/slot-1')
  for (const path of ['/etc/passwd', '../a.txt', 'in/../../a.txt', 'in/../a.txt', './a.txt', 'in//a.txt', 'a.txt/', '']) {
    await assert.rejects(slot.start({ ...quick, inputs: [{ data: encode('a'), path }] }), /the input path .* is not a relative path in the unit directory/)
    await assert.rejects(slot.read(path), /the output path .* is not a relative path in the unit directory/)
  }
  await assert.rejects(slot.read('/etc/passwd'), /the output path "\/etc\/passwd"/)
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, maxUnitMs + 1]) await assert.rejects(slot.start({ ...quick, timeoutMs }), /the time limit .* is not an integer/)
  await assert.rejects(slot.start({ ...quick, argv: [] }), /the argv of a unit/)
  // An object refuses the name of another slot.
  const other = scanSlot(box, memoryStore({ job: 'scan.pool-1.slot-2.x', name: 'pool-1/slot-2', timeoutMs: 60_000 }), 'pool-1/slot-1')
  await assert.rejects(other.poll(), /this object holds the slot pool-1\/slot-2, not pool-1\/slot-1/)
  assert.deepEqual(calls, [])
})

test('a scan slot names a missing output file, and refuses an output over the size limit', async () => {
  const { dir, slot } = slotFixture()
  await slot.start({ ...quick, argv: ['touch', 'huge.bin'] })
  assert.equal((await finished(slot)).exit_code, 0)
  truncateSync(join(dir, 'huge.bin'), artifactSizeLimit + 1)
  await assert.rejects(slot.read('out/missing.txt'), /read out\/missing\.txt: no such file in scan\/pool-1\/slot-1/)
  await assert.rejects(slot.read('huge.bin'), new RegExp(`read huge\\.bin: the file has ${artifactSizeLimit + 1} bytes, over the limit`))
})
