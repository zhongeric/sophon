import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { r2DataStore, type DataBucket } from '../src/cloudflare/r2.ts'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text)

/** A bucket in memory that counts each put. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>()
  const puts: string[] = []
  const bucket: DataBucket = {
    head: async (key) => (objects.has(key) ? { key } : null),
    get: async (key) => {
      const value = objects.get(key)
      return value ? { arrayBuffer: async () => value.slice().buffer } : null
    },
    put: async (key, value) => {
      puts.push(key)
      objects.set(key, new Uint8Array(value))
      return { key }
    },
  }
  return { bucket, objects, puts }
}

test('R2 data store: put gives the SHA-256 key, and a second put of the same bytes writes nothing new', async () => {
  const { bucket, objects, puts } = fakeBucket()
  const store = r2DataStore(bucket)
  const id = await store.put(bytes('light curve'))
  assert.equal(id, sha256(bytes('light curve')))
  assert.equal(await store.put(bytes('light curve')), id)
  assert.deepEqual(puts, [id])
  assert.deepEqual([...objects.keys()], [id])
  assert.deepEqual(await store.get(id), bytes('light curve'))
})

test('R2 data store: get gives null for an unknown or malformed ID', async () => {
  const { bucket } = fakeBucket()
  const store = r2DataStore(bucket)
  assert.equal(await store.get('b'.repeat(64)), null)
  for (const id of ['', '../x', 'B'.repeat(64), 'b'.repeat(65)]) assert.equal(await store.get(id), null, id)
})
