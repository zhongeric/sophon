import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { containerBox, type Box, type BoxResult } from '../src/cloudflare/box.ts'
import { maxUnitMs, scanSlot, slotInactivityMs, type SlotState, type SlotStore, type Unit } from '../src/cloudflare/scan-slot.ts'
import { artifactSizeLimit } from '../src/core/artifacts.ts'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

function memoryStore(initial: SlotState | null = null): SlotStore {
  let state = initial
  return { read: () => state, save: (next) => void (state = next) }
}

/**
 * A container whose root is a local directory. It comes back empty when it starts, as a stopped Cloudflare Container
 * does, and it keeps its start options and each inactivity timeout.
 */
function localContainer(root: string) {
  const container = {
    running: false,
    starts: [] as { enableInternet: boolean }[],
    timeouts: [] as number[],
    start(options: { enableInternet: boolean; entrypoint: string[]; env: Record<string, string> }) {
      rmSync(root, { force: true, recursive: true })
      mkdirSync(root, { recursive: true })
      container.starts.push({ enableInternet: options.enableInternet })
      container.running = true
    },
    async setInactivityTimeout(durationMs: number) {
      container.timeouts.push(durationMs)
    },
    async exec(argv: string[], options: { cwd: string; env: Record<string, string>; stdin?: ReadableStream }) {
      // The box wraps each command in timeout -k 10 <seconds>.
      const command = argv.slice(4)
      const cwd = join(root, options.cwd)
      const input = options.stdin ? Buffer.from(await new Response(options.stdin).arrayBuffer()) : undefined
      // A user other than root cannot read /root/.bashrc, and bash reads it when its stdin is a socket. Thus HOME is the
      // root of this container, which has no .bashrc.
      const env = { ...options.env, HOME: root }
      const result = existsSync(cwd) ? spawnSync(command[0]!, command.slice(1), { cwd, env, input }) : { status: 1, stdout: '', stderr: `no directory ${options.cwd}` }
      return { stdout: new Blob([`${result.stdout}${result.stderr}`]).stream(), exitCode: Promise.resolve(result.status ?? 1) }
    },
  }
  return container
}

/** A scan slot over a local container, with the inactivity timeout of a scan box. */
function slotFixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-scan-'))
  const container = localContainer(root)
  const store = memoryStore()
  const box = containerBox(container, { enableInternet: false, inactivityMs: () => slotInactivityMs(store.read()), onStart: () => {} })
  return { container, dir: join(root, 'scan/pool-1/slot-1'), root, slot: scanSlot(box, store, 'pool-1/slot-1'), store }
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
  await slot.start({ argv: ['bash', '-c', 'cat in.txt; printf " %s" "$NUMBA_CACHE_DIR"'], inputs: [{ data: encode('in'), path: 'in.txt' }], timeoutMs: limit })
  assert.deepEqual(container.starts, [{ enableInternet: false }])
  // The start of the job renews the timeout with the new time limit, and no poll comes before the end of the job.
  assert.ok((container.timeouts.at(-1) ?? 0) > limit, String(container.timeouts))
  assert.deepEqual(await finished(slot), { exit_code: 0, output: 'in /opt/numba-cache' })

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
