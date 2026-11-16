import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
