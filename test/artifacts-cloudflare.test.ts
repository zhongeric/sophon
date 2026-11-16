import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import { artifactId } from '../src/core/artifacts.ts'
import { artifactChunkSize, createArtifactTables, sqlArtifacts, type ArtifactStorage, type SqlValue } from '../src/cloudflare/artifacts.ts'
import { artifactContract } from './support/artifacts.ts'

/** Durable Object SQL over node:sqlite: blobs go in and come out as ArrayBuffer, and a throw rolls the transaction back. */
function fakeStorage(options: { failOn?: RegExp } = {}): ArtifactStorage {
  const db = new DatabaseSync(':memory:')
  const input = (value: SqlValue): SQLInputValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)
  const output = (value: unknown): SqlValue => {
    if (value instanceof Uint8Array) return new Uint8Array(value).buffer
    if (value === null || typeof value === 'string' || typeof value === 'number') return value
    throw new Error(`unexpected SQL value ${String(value)}`)
  }
  const storage: ArtifactStorage = {
    sql: {
      exec(query, ...bindings) {
        if (options.failOn?.test(query)) throw new Error('injected failure')
        const rows: unknown[] = db.prepare(query).all(...bindings.map(input))
        return {
          toArray: () =>
            rows.map((row) => {
              if (typeof row !== 'object' || row === null) throw new Error('unexpected SQL row')
              return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, output(value)]))
            }),
        }
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN')
      try {
        fn()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  createArtifactTables(storage.sql)
  return storage
}

const fetched = { source: { url: 'https://example.com/a', method: 'GET' }, media_type: 'application/octet-stream' }

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 251
  return bytes
}

const chunkRows = (storage: ArtifactStorage, run: string, id?: string) =>
  storage.sql.exec('select count(*) as count, max(length(data)) as largest from factory_artifact_chunks where run = ? and (? is null or id = ?)', run, id ?? null, id ?? null).toArray()[0]

artifactContract('Durable Object SQL store', async () => sqlArtifacts(fakeStorage(), 'run-1'))

test('chunk boundary sizes round trip byte for byte, in chunks no larger than the chunk size', async () => {
  const storage = fakeStorage()
  const store = sqlArtifacts(storage, 'run-1')
  const sizes = [0, 1, artifactChunkSize - 1, artifactChunkSize, artifactChunkSize + 1, 2 * artifactChunkSize, 2 * artifactChunkSize + 1]
  for (const size of sizes) {
    const bytes = pattern(size)
    const id = await store.put(bytes, fetched)
    assert.deepEqual(await store.get(id), bytes, `size ${size}`)
    assert.equal((await store.meta(id))?.size, size)
    const rows = chunkRows(storage, 'run-1', id)
    assert.equal(rows?.count, Math.ceil(size / artifactChunkSize), `chunks for size ${size}`)
    assert.ok(size === 0 || (typeof rows?.largest === 'number' && rows.largest <= artifactChunkSize), `largest chunk for size ${size}`)
  }
})

test('a put that fails inside the transaction leaves no chunks and no meta', async () => {
  const storage = fakeStorage({ failOn: /^insert into factory_artifacts\b/ })
  const store = sqlArtifacts(storage, 'run-1')
  const bytes = pattern(2 * artifactChunkSize + 1)
  await assert.rejects(store.put(bytes, fetched), /injected failure/)
  assert.equal(chunkRows(storage, 'run-1')?.count, 0)
  assert.equal(storage.sql.exec('select count(*) as count from factory_artifacts').toArray()[0]?.count, 0)
  const id = await artifactId(bytes)
  assert.equal(await store.get(id), null)
  assert.equal(await store.meta(id), null)
  assert.deepEqual(await store.list(), [])
})

test('two runs on one database do not see the artifacts of each other', async () => {
  const storage = fakeStorage()
  const first = sqlArtifacts(storage, 'run-1')
  const second = sqlArtifacts(storage, 'run-2')
  const bytes = pattern(10)
  const id = await first.put(bytes, { ...fetched, labels: { run: 'one' } })
  assert.equal(await second.get(id), null)
  assert.equal(await second.meta(id), null)
  assert.deepEqual(await second.list(), [])
  assert.equal(await second.put(bytes, { ...fetched, labels: { run: 'two' } }), id)
  assert.deepEqual((await first.meta(id))?.labels, { run: 'one' })
  assert.deepEqual((await second.meta(id))?.labels, { run: 'two' })
  const other = await second.put(pattern(20), fetched)
  assert.equal(await first.get(other), null)
  assert.deepEqual((await first.list()).map((entry) => entry.id), [id])
  assert.deepEqual((await second.list()).map((entry) => entry.id).sort(), [id, other].sort())
})
