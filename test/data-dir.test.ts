import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dirDataStore } from '../src/node/data-dir.ts'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text)

test('directory data store: put gives the SHA-256, and the same bytes give one file', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'data-dir-')), 'data')
  const store = dirDataStore(dir)
  const id = await store.put(bytes('light curve'))
  assert.equal(id, sha256(bytes('light curve')))
  assert.equal(await store.put(bytes('light curve')), id)
  assert.deepEqual(readdirSync(dir), [id])
  assert.deepEqual(await store.get(id), bytes('light curve'))
  assert.equal(await store.put(new Uint8Array()), sha256(new Uint8Array()))
  assert.deepEqual(await store.get(sha256(new Uint8Array())), new Uint8Array())
})

test('directory data store: get gives null for an unknown or malformed ID, and never reads outside the directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'data-dir-'))
  writeFileSync(join(root, 'secret'), 'outside')
  const store = dirDataStore(join(root, 'data'))
  assert.equal(await store.get('a'.repeat(64)), null)
  for (const id of ['', '../secret', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/x`]) assert.equal(await store.get(id), null, id)
})
