import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { localScanBoxes } from '../src/node/scan-boxes.ts'

test('local scan boxes: setup creates files and environment for each fresh unit checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-boxes-'))
  const boxes = localScanBoxes(dir, {
    stack: 'python',
    checks: {},
    setup: 'test ! -e generated && printf ready > generated && export UNIT_ENV=ready # dependencies',
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await boxes.start('run/u1', {
        command: 'test "$UNIT_ENV" = ready && cat generated > output && printf changed > generated',
        inputs: [],
        timeoutMs: 5_000,
      })
      let state = await boxes.poll('run/u1')
      while (state.state === 'running') {
        await new Promise((done) => setTimeout(done, 10))
        state = await boxes.poll('run/u1')
      }
      assert.equal(state.state, 'done')
      if (state.state !== 'done') throw new Error('the unit is missing')
      assert.equal(state.result.exit_code, 0, state.result.output)
      assert.equal(new TextDecoder().decode(await boxes.read('run/u1', 'output')), 'ready')
    }
  } finally {
    await boxes.kill('run/u1')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local scan boxes: a failed setup prevents the unit command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-boxes-'))
  const boxes = localScanBoxes(dir, { stack: 'python', checks: {}, setup: '(exit 7) # dependencies' })
  try {
    await boxes.start('run/u1', { command: 'touch output', inputs: [], timeoutMs: 5_000 })
    let state = await boxes.poll('run/u1')
    while (state.state === 'running') {
      await new Promise((done) => setTimeout(done, 10))
      state = await boxes.poll('run/u1')
    }
    assert.equal(state.state, 'done')
    if (state.state !== 'done') throw new Error('the unit is missing')
    assert.equal(state.result.exit_code, 7)
    assert.equal(existsSync(join(dir, 'run', 'u1', 'output')), false)
  } finally {
    await boxes.kill('run/u1')
    rmSync(dir, { recursive: true, force: true })
  }
})

/** False when the process is gone or is a zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
  } catch {
    return true
  }
}

/** A host process that starts one unit on local scan boxes, prints ready when the unit runs, and exits itself for `exit`. */
async function hostWithUnit(dir: string, end: 'exit' | 'SIGINT' | 'SIGTERM'): Promise<number> {
  const url = pathToFileURL(join(import.meta.dirname, '../src/node/scan-boxes.ts')).href
  const pidFile = join(dir, 'run', 'u1', 'pid')
  const script = `
    import { existsSync } from 'node:fs'
    import { localScanBoxes } from ${JSON.stringify(url)}
    const boxes = localScanBoxes(${JSON.stringify(dir)}, { stack: 'python', checks: {} })
    await boxes.start('run/u1', { command: 'sleep 60 & echo $! > pid.tmp && mv pid.tmp pid && wait', inputs: [], timeoutMs: 60_000 })
    while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((done) => setTimeout(done, 20))
    if (${JSON.stringify(end)} === 'exit') process.exit(2)
    console.log('ready')
    setInterval(() => {}, 1000)
  `
  const host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<void>((done) => host.on('exit', () => done()))
  if (end !== 'exit') {
    await new Promise<void>((done) => host.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && done()))
    host.kill(end)
  }
  await exited
  assert.ok(existsSync(pidFile), 'the unit did not start')
  return Number(readFileSync(pidFile, 'utf8').trim())
}

for (const end of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  test(`local scan boxes: no unit process stays after the host ends with ${end}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-boxes-'))
    try {
      const pid = await hostWithUnit(dir, end)
      const deadline = Date.now() + 5_000
      while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
      assert.equal(alive(pid), false, `the unit process ${pid} still runs`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
