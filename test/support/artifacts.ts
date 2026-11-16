import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { artifactId, artifactMeta, artifactSizeLimit, checkArtifactSize, isArtifactId } from '../../src/core/artifacts.ts'
import type { ArtifactMeta, Artifacts } from '../../src/core/platform.ts'

/** An in-memory store for tests, built on the core helpers. */
export function memoryArtifacts(): Artifacts {
  const stored = new Map<string, { bytes: Uint8Array; meta: ArtifactMeta }>()
  return {
    async put(bytes, meta) {
      checkArtifactSize(bytes.length)
      const id = await artifactId(bytes)
      if (!stored.has(id)) stored.set(id, { bytes: new Uint8Array(bytes), meta: artifactMeta(meta, bytes.length, Date.now()) })
      return id
    },
    get: async (id) => {
      const entry = isArtifactId(id) ? stored.get(id) : undefined
      return entry ? new Uint8Array(entry.bytes) : null
    },
    meta: async (id) => (isArtifactId(id) ? stored.get(id)?.meta ?? null : null),
    list: async () =>
      [...stored].map(([id, { meta }]) => ({ id, meta })).sort((a, b) => a.meta.created - b.meta.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

const text = (value: string) => new TextEncoder().encode(value)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const fetched = { source: { url: 'https://example.com/a', method: 'GET' }, media_type: 'text/html' }

/** The cases that every Artifacts store must pass. `make` gives a new, empty store for each case. */
export function artifactContract(name: string, make: () => Promise<Artifacts>): void {
  test(`${name}: the same bytes give the same ID, the SHA-256 hex of the bytes`, async () => {
    const store = await make()
    const bytes = text('hello artifact')
    const id = await store.put(bytes, fetched)
    assert.equal(id, sha256(bytes))
    assert.equal(await store.put(text('hello artifact'), fetched), id)
    assert.deepEqual(await store.get(id), bytes)
    assert.deepEqual((await store.list()).map((entry) => entry.id), [id])
  })

  test(`${name}: a second put with other meta keeps the first meta and returns the same ID`, async () => {
    const store = await make()
    const bytes = text('first wins')
    const id = await store.put(bytes, { ...fetched, labels: { step: 'one' } })
    const first = await store.meta(id)
    await sleep(5)
    const again = await store.put(bytes, { source: { command: 'curl x' }, media_type: 'text/plain', labels: { step: 'two' } })
    assert.equal(again, id)
    assert.deepEqual(await store.meta(id), first)
    assert.deepEqual(first?.labels, { step: 'one' })
    assert.equal((await store.list()).length, 1)
  })

  test(`${name}: the meta round trips, and the store sets the size and the time`, async () => {
    const store = await make()
    const before = Date.now()
    const page = text('<html></html>')
    const pageId = await store.put(page, { ...fetched, labels: { query: 'vault fees', rank: '1' } })
    // Extra keys of the caller cannot set the size or the time.
    const input = { source: { command: 'forge test --match-test testFee' }, media_type: 'text/plain', size: 1, created: 1 }
    const outputId = await store.put(text('ok\n'), input)
    const after = Date.now()
    const pageMeta = await store.meta(pageId)
    assert.ok(pageMeta)
    assert.deepEqual(pageMeta, { ...fetched, labels: { query: 'vault fees', rank: '1' }, size: page.length, created: pageMeta.created })
    assert.ok(pageMeta.created >= before && pageMeta.created <= after)
    const outputMeta = await store.meta(outputId)
    assert.ok(outputMeta)
    assert.deepEqual(outputMeta, { source: { command: 'forge test --match-test testFee' }, media_type: 'text/plain', labels: {}, size: 3, created: outputMeta.created })
    assert.ok(outputMeta.created >= before && outputMeta.created <= after)
  })

  test(`${name}: a label with the key __proto__ round trips`, async () => {
    const store = await make()
    const labels = Object.fromEntries([['__proto__', 'text'], ['kind', 'page']])
    const id = await store.put(text('label keys'), { ...fetched, labels })
    const entries = [['__proto__', 'text'], ['kind', 'page']]
    assert.deepEqual(Object.entries((await store.meta(id))?.labels ?? {}), entries)
    assert.deepEqual(Object.entries((await store.list())[0]?.meta.labels ?? {}), entries)
  })

  test(`${name}: empty bytes are an artifact`, async () => {
    const store = await make()
    const id = await store.put(new Uint8Array(), fetched)
    assert.equal(id, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.deepEqual(await store.get(id), new Uint8Array())
    assert.equal((await store.meta(id))?.size, 0)
  })

  test(`${name}: unknown and malformed IDs give null`, async () => {
    const store = await make()
    const id = await store.put(text('known'), fetched)
    assert.equal(await store.get('0'.repeat(64)), null)
    assert.equal(await store.meta('0'.repeat(64)), null)
    for (const bad of [id.toUpperCase(), '../x', 'a/b', '', id.slice(0, 63), `${id}.json`]) {
      assert.equal(await store.get(bad), null, bad)
      assert.equal(await store.meta(bad), null, bad)
    }
  })

  test(`${name}: the size limit accepts exactly the limit and refuses more, and stores nothing`, async () => {
    const store = await make()
    const largest = new Uint8Array(artifactSizeLimit).fill(7)
    const id = await store.put(largest, fetched)
    assert.equal((await store.meta(id))?.size, artifactSizeLimit)
    assert.equal((await store.get(id))?.length, artifactSizeLimit)
    const over = new Uint8Array(artifactSizeLimit + 1)
    await assert.rejects(store.put(over, fetched), (error: Error) => {
      assert.match(error.message, new RegExp(`\\b${artifactSizeLimit + 1}\\b`))
      assert.match(error.message, new RegExp(`\\b${artifactSizeLimit}\\b`))
      return true
    })
    const overId = await artifactId(over)
    assert.equal(await store.get(overId), null)
    assert.equal(await store.meta(overId), null)
    assert.deepEqual((await store.list()).map((entry) => entry.id), [id])
  })

  test(`${name}: an empty store lists nothing`, async () => {
    const store = await make()
    assert.deepEqual(await store.list(), [])
  })

  test(`${name}: the list is in the order of created, then of ID`, async () => {
    const store = await make()
    const [high, low] = [text('a'), text('b')].sort((a, b) => (sha256(a) < sha256(b) ? 1 : -1))
    assert.ok(high && low)
    // The higher ID goes first, so only the time can put it first in the list.
    const highId = await store.put(high, fetched)
    await sleep(5)
    const lowId = await store.put(low, fetched)
    await sleep(5)
    const quick = await Promise.all([text('c'), text('d'), text('e')].map((bytes) => store.put(bytes, fetched)))
    const listed = await store.list()
    assert.deepEqual(listed.slice(0, 2).map((entry) => entry.id), [highId, lowId])
    assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set([highId, lowId, ...quick]))
    const sorted = [...listed].sort((a, b) => a.meta.created - b.meta.created || (a.id < b.id ? -1 : 1))
    assert.deepEqual(listed, sorted)
    for (const entry of listed) assert.deepEqual(entry.meta, await store.meta(entry.id))
  })
}
