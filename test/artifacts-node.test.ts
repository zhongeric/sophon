import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactId } from '../src/core/artifacts.ts'
import { nodeArtifacts } from '../src/node/artifacts.ts'
import { artifactContract } from './support/artifacts.ts'

const runDir = () => mkdtempSync(join(tmpdir(), 'factory-artifacts-'))
const text = (value: string) => new TextEncoder().encode(value)
const fetched = { source: { url: 'https://example.com/a', method: 'GET' }, media_type: 'text/html', labels: { query: 'fees' } }

artifactContract('node store', async () => nodeArtifacts(runDir()))

test('the files are <id> and <id>.json under <runDir>/artifacts/', async () => {
  const dir = runDir()
  const bytes = text('<html></html>')
  const id = await nodeArtifacts(dir).put(bytes, fetched)
  assert.deepEqual(readdirSync(dir), ['artifacts'])
  assert.deepEqual(readdirSync(join(dir, 'artifacts')).sort(), [id, `${id}.json`])
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'artifacts', id))), bytes)
  const meta = JSON.parse(readFileSync(join(dir, 'artifacts', `${id}.json`), 'utf8'))
  assert.deepEqual(meta, { ...fetched, size: bytes.length, created: meta.created })
})

test('a stray temporary file and bytes without meta do not show', async () => {
  const dir = runDir()
  const store = nodeArtifacts(dir)
  const kept = await store.put(text('kept'), fetched)
  // A crash after the bytes file and before the meta file, and a crash during a write.
  const crashed = text('crashed')
  const crashedId = await artifactId(crashed)
  writeFileSync(join(dir, 'artifacts', crashedId), crashed)
  writeFileSync(join(dir, 'artifacts', `.tmp-${crashedId}.json-1234`), '{"size":')
  assert.deepEqual((await store.list()).map((entry) => entry.id), [kept])
  assert.equal(await store.get(crashedId), null)
  assert.equal(await store.meta(crashedId), null)
  // A new put of the same bytes completes the artifact.
  assert.equal(await store.put(crashed, fetched), crashedId)
  assert.deepEqual(await store.get(crashedId), crashed)
  assert.deepEqual(new Set((await store.list()).map((entry) => entry.id)), new Set([kept, crashedId]))
})

test('a malformed ID never reads a file outside the store', async () => {
  const dir = runDir()
  const store = nodeArtifacts(dir)
  await store.put(text('inside'), fetched)
  writeFileSync(join(dir, 'secret'), 'outside')
  writeFileSync(join(dir, 'secret.json'), JSON.stringify({ ...fetched, size: 7, created: 1 }))
  for (const bad of ['../secret', '../secret.json', join(dir, 'secret')]) {
    assert.equal(await store.get(bad), null, bad)
    assert.equal(await store.meta(bad), null, bad)
  }
})

test('a missing directory lists nothing and is created on the first put', async () => {
  const dir = join(runDir(), 'run')
  const store = nodeArtifacts(dir)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.get('0'.repeat(64)), null)
  const id = await store.put(text('first'), fetched)
  assert.deepEqual(readdirSync(join(dir, 'artifacts')).sort(), [id, `${id}.json`])
})

test('a second store on the same directory reads what the first one wrote', async () => {
  const dir = runDir()
  const first = nodeArtifacts(dir)
  const bytes = text('shared')
  const id = await first.put(bytes, fetched)
  const second = nodeArtifacts(dir)
  assert.deepEqual(await second.get(id), bytes)
  assert.deepEqual(await second.meta(id), await first.meta(id))
  assert.deepEqual(await second.list(), await first.list())
  // The first meta wins across stores too.
  assert.equal(await second.put(bytes, { source: { command: 'cat shared' }, media_type: 'text/plain' }), id)
  assert.deepEqual(await first.meta(id), await second.meta(id))
  assert.equal((await first.meta(id))?.media_type, 'text/html')
})

test('two puts of the same bytes at the same time keep one meta', async () => {
  const dir = runDir()
  const bytes = text('raced')
  const command = { source: { command: 'cat raced' }, media_type: 'text/plain' }
  const one = nodeArtifacts(runDir())
  // One store, and two stores on one directory, as two processes on one run directory.
  for (const [a, other] of [[one, one], [nodeArtifacts(dir), nodeArtifacts(dir)]]) {
    assert.ok(a && other)
    const [first, second] = await Promise.all([a.put(bytes, fetched), other.put(bytes, command)])
    assert.equal(first, second)
    const kept = await a.meta(first)
    assert.ok(kept)
    // The meta does not change after the puts return, and each later put keeps it.
    await Promise.all([a.put(bytes, command), other.put(bytes, fetched)])
    assert.deepEqual(await a.meta(first), kept)
    assert.deepEqual(await other.meta(first), kept)
  }
  // A meta file comes from a hard link, so no temporary file stays.
  assert.deepEqual(readdirSync(join(dir, 'artifacts')).filter((name) => name.startsWith('.tmp-')), [])
})

test('a meta file that is not a valid meta does not show, and a new put replaces it', async () => {
  for (const bad of ['', '{"source":{"url":', '{}', '[]', JSON.stringify({ ...fetched, size: '13', created: 1 })]) {
    const dir = runDir()
    const store = nodeArtifacts(dir)
    const kept = await store.put(text('kept'), fetched)
    const bytes = text('cut')
    const id = await store.put(bytes, fetched)
    writeFileSync(join(dir, 'artifacts', `${id}.json`), bad)
    assert.equal(await store.meta(id), null, bad)
    assert.equal(await store.get(id), null, bad)
    assert.deepEqual((await store.list()).map((entry) => entry.id), [kept], bad)
    assert.equal(await store.put(bytes, fetched), id)
    const meta = await store.meta(id)
    assert.ok(meta, bad)
    assert.deepEqual(meta, { ...fetched, size: bytes.length, created: meta.created }, bad)
    assert.deepEqual(await store.get(id), bytes, bad)
  }
})

test('two repairs keep the meta that the first put commits', { timeout: 5_000 }, async (t) => {
  const dir = runDir()
  const first = nodeArtifacts(dir)
  const second = nodeArtifacts(dir)
  const bytes = text('repair race')
  const id = await first.put(bytes, fetched)
  const path = join(dir, 'artifacts', `${id}.json`)
  const lock = join(dir, 'artifacts', `.repair-${id}`)
  writeFileSync(path, '{')

  const signal = () => {
    let resolve = () => {}
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }
  const paused = signal()
  const contended = signal()
  const committed = signal()
  const rename = fs.rename
  const mkdir = fs.mkdir
  let replacements = 0
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  t.mock.method(fs, 'rename', async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (to === path) {
      replacements++
      if (replacements === 1) {
        // Stop before the first repair replaces the invalid meta.
        paused.resolve()
        await contended.promise
      } else {
        // Without the lock, the second repair replaces meta after the first put returns.
        contended.resolve()
        await committed.promise
      }
    }
    await rename(from, to)
  })
  t.mock.method(fs, 'mkdir', async (path: Parameters<typeof mkdir>[0], options?: Parameters<typeof mkdir>[1]): Promise<undefined> => {
    try {
      await mkdir(path, options)
      return undefined
    } catch (error) {
      if (path === lock) contended.resolve()
      throw error
    }
  })
  syncBuiltinESMExports()

  const firstPut = first.put(bytes, fetched)
  await paused.promise
  const secondPut = second.put(bytes, { source: { command: 'cat repair' }, media_type: 'text/plain' })
  assert.equal(await firstPut, id)
  const kept = await first.meta(id)
  committed.resolve()
  assert.equal(await secondPut, id)
  assert.ok(kept)
  assert.deepEqual(kept, { ...fetched, size: bytes.length, created: kept.created })
  assert.deepEqual(await second.meta(id), kept)
  assert.equal(replacements, 1)
  assert.deepEqual(readdirSync(join(dir, 'artifacts')).sort(), [id, `${id}.json`])
})

test('meta without its bytes file does not show, and a new put writes the bytes again', async () => {
  const dir = runDir()
  const store = nodeArtifacts(dir)
  const bytes = text('lost')
  const id = await store.put(bytes, fetched)
  const first = await store.meta(id)
  rmSync(join(dir, 'artifacts', id))
  assert.equal(await store.meta(id), null)
  assert.equal(await store.get(id), null)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.put(bytes, { source: { command: 'cat lost' }, media_type: 'text/plain' }), id)
  assert.deepEqual(await store.get(id), bytes)
  // The meta file stayed, so the first meta wins.
  assert.deepEqual(await store.meta(id), first)
})
