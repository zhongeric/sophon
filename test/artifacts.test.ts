import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { artifactMeta, artifactSizeLimit, artifactsFileSystem, checkArtifactSize, isArtifactId } from '../src/core/artifacts.ts'
import { createWorkspace } from '../src/core/workspace.ts'
import { artifactContract, memoryArtifacts } from './support/artifacts.ts'

artifactContract('memory store', async () => memoryArtifacts())

const signal = new AbortController().signal
const text = (value: string) => new TextEncoder().encode(value)
const fetched = { source: { url: 'https://example.com/a', method: 'GET' }, media_type: 'text/html', labels: { query: 'fees' } }

async function mounted() {
  const store = memoryArtifacts()
  const workspace = await createWorkspace({ repo: MemoryFileSystem.create({ files: { '/a.ts': 'a' } }), review: {}, artifacts: store })
  const run = (command: string) => workspace.run({ command, cwd: '/repo', timeout_ms: 5_000 }, signal)
  return { store, workspace, run }
}

test('the limit is 32 MiB, and only lowercase SHA-256 hex is an ID', () => {
  assert.equal(artifactSizeLimit, 33554432)
  checkArtifactSize(artifactSizeLimit)
  assert.throws(() => checkArtifactSize(artifactSizeLimit + 1), /artifact of 33554433 bytes is over the limit of 33554432 bytes/)
  assert.ok(isArtifactId('a'.repeat(64)))
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`, '', '../x']) assert.ok(!isArtifactId(bad), bad)
})

test('the stored meta keeps only the known fields', () => {
  const input = { source: { url: 'https://example.com', method: 'GET', extra: 'x' }, media_type: 'text/html', size: 1, created: 1 }
  assert.deepEqual(artifactMeta(input, 10, 20), { source: { url: 'https://example.com', method: 'GET' }, media_type: 'text/html', labels: {}, size: 10, created: 20 })
})

test('the mount shows the bytes at /artifacts/<id> and the meta at /artifacts/<id>.json', async () => {
  const { store, workspace, run } = await mounted()
  const id = await store.put(text('<html>fees</html>'), fetched)
  const meta = await store.meta(id)
  assert.equal((await run(`cat /artifacts/${id}`)).stdout, '<html>fees</html>')
  assert.equal((await run(`cat /artifacts/${id}.json`)).stdout, `${JSON.stringify(meta, null, 2)}\n`)
  assert.equal(await workspace.read(`/artifacts/${id}`), '<html>fees</html>')
  assert.deepEqual(JSON.parse((await run(`cat /artifacts/${id}.json`)).stdout), { ...fetched, size: 17, created: meta?.created })
  assert.deepEqual((await run('ls /artifacts')).stdout.split(/\s+/).filter(Boolean).sort(), [id, `${id}.json`])
})

test('the mount of an empty store is an empty directory', async () => {
  const { run } = await mounted()
  const listed = await run('ls /artifacts')
  assert.equal(listed.stdout, '')
  assert.equal(listed.stderr, '')
})

test('the mount is live: a put after the workspace starts shows at once', async () => {
  const { store, run } = await mounted()
  const first = await store.put(text('one'), fetched)
  assert.deepEqual((await run('ls /artifacts')).stdout.split(/\s+/).filter(Boolean).sort(), [first, `${first}.json`])
  const second = await store.put(text('two'), { source: { command: 'echo two' }, media_type: 'text/plain' })
  assert.deepEqual((await run('ls /artifacts')).stdout.split(/\s+/).filter(Boolean).sort(), [first, `${first}.json`, second, `${second}.json`].sort())
  assert.equal((await run(`cat /artifacts/${second}`)).stdout, 'two')
})

test('the mount refuses every write, removal, mkdir and rename', async () => {
  const { store, workspace, run } = await mounted()
  const id = await store.put(text('keep'), fetched)
  await assert.rejects(workspace.write('/artifacts/new.txt', 'x'), /Read-only file system/)
  await assert.rejects(workspace.write(`/artifacts/${id}`, 'x'), /Read-only file system/)
  assert.match((await run('echo x > /artifacts/new.txt')).stderr, /Read-only file system/)
  assert.match((await run(`echo x >> /artifacts/${id}`)).stderr, /Read-only file system/)
  assert.match((await run(`rm /artifacts/${id}`)).stderr, /Read-only file system/)
  assert.match((await run('mkdir /artifacts/dir')).stderr, /Read-only file system/)
  assert.match((await run(`mv /artifacts/${id} /artifacts/moved`)).stderr, /Read-only file system/)
  assert.equal((await run(`cat /artifacts/${id}`)).stdout, 'keep')
  assert.deepEqual((await run('ls /artifacts')).stdout.split(/\s+/).filter(Boolean).sort(), [id, `${id}.json`])
})

test('a read of an unknown or malformed name fails', async () => {
  const { store, workspace, run } = await mounted()
  const id = await store.put(text('known'), fetched)
  for (const name of ['0'.repeat(64), id.toUpperCase(), `${id}.txt`, 'notes.md']) {
    assert.equal(await workspace.read(`/artifacts/${name}`), null, name)
    const result = await run(`cat /artifacts/${name}`)
    assert.equal(result.stdout, '', name)
    assert.notEqual(result.stderr, '', name)
  }
  const fs = artifactsFileSystem(store)
  await assert.rejects(fs.read(`/${'0'.repeat(64)}`), { code: 'ENOENT' })
  await assert.rejects(fs.read('/../x'), { code: 'ENOENT' })
  await assert.rejects(fs.write(`/${id}`, text('x')), { code: 'EROFS' })
  assert.equal(await fs.stat('/unknown'), null)
  assert.deepEqual(await fs.stat(`/${id}`), { kind: 'file', mode: 0o444, mtime: (await store.meta(id))?.created, size: 5 })
  assert.equal((await fs.stat('/'))?.kind, 'directory')
})
