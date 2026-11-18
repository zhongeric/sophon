import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { mockServices } from './support/mock-services.ts'
import { startWorker, until } from './support/wrangler.ts'

let mock: Awaited<ReturnType<typeof mockServices>>
let worker: Awaited<ReturnType<typeof startWorker>>
const describe = () => `jobs: ${JSON.stringify(mock.state.jobs)}\nworker:\n${worker.output().slice(-4000)}`
const call = (method: string, body: unknown) => fetch(`${worker.url}/${method}`, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' })

before(async () => {
  mock = await mockServices(mkdtempSync(join(tmpdir(), 'factory-repo-')), {
    botLogin: 'factory-bot',
    name: 'app',
    owner: 'acme',
    script: () => {
      throw new Error('this test has no model turns')
    },
  })
  try {
    worker = await startWorker({ MACHINE_URL: `${mock.url}/machine` }, { entry: 'test/support/scan-worker.js' })
  } catch (error) {
    await mock.close()
    throw error
  }
})

after(async () => {
  await worker?.stop()
  await mock?.close()
})

test('on Cloudflare, a scan box copies the input file of a unit in, runs its command as a job, and gives the exact bytes of its output file', { timeout: 300_000 }, async () => {
  const name = 'pool-1/slot-1'
  const input = Uint8Array.from({ length: 256 }, (_, index) => index)
  const started = await call('start', {
    argv: ['bash', '-c', 'mkdir out && cp in/data.bin out/data.bin && printf %s "$NUMBA_CACHE_DIR"'],
    inputs: [{ base64: Buffer.from(input).toString('base64'), path: 'in/data.bin' }],
    name,
    timeoutMs: 60_000,
  })
  assert.equal(started.status, 200, await started.clone().text())
  const { job } = (await started.json()) as { job: string }
  assert.match(job, /^scan\.pool-1\.slot-1\./)
  assert.deepEqual(mock.state.jobs.map((entry) => [entry.id, entry.cwd]), [[job, 'scan/pool-1/slot-1']])

  const done = await until(
    async () => {
      const state = (await (await call('poll', { name })).json()) as { state: string }
      return state.state === 'running' ? undefined : state
    },
    60_000,
    describe,
  )
  assert.deepEqual(done, { result: { exit_code: 0, output: '/opt/numba-cache' }, state: 'done' })

  const output = await call('read', { name, path: 'out/data.bin' })
  assert.equal(output.status, 200, describe())
  assert.deepEqual(new Uint8Array(await output.arrayBuffer()), input)
  const missing = await call('read', { name, path: 'out/missing.bin' })
  assert.equal(missing.status, 500)
  assert.match(await missing.text(), /read out\/missing\.bin: no such file in scan\/pool-1\/slot-1/)
})
