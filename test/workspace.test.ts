import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { hostFetch, type AgentHost } from '../src/core/agent.ts'
import { runLock } from '../src/core/egress.ts'
import { createWorkspace, guard, readOnly } from '../src/core/workspace.ts'
import { diskFileSystem } from '../src/node/disk.ts'
import { fileLedger } from '../src/node/ledger.ts'
import { sqliteStore } from '../src/node/platform.ts'
import { memoryArtifacts } from './support/artifacts.ts'
import { credentials, module } from './support/fixture.ts'

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'factory-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'factory-outside-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(outside, 'secret'), 'key')
  symlinkSync(outside, join(root, 'escape'))
  return root
}

const signal = new AbortController().signal
const run = (workspace: Awaited<ReturnType<typeof createWorkspace>>, command: string) => workspace.run({ command, cwd: '/repo', timeout_ms: 5_000 }, signal)

test('a read-only workspace reads, searches, and refuses every write', async () => {
  const root = tree()
  const workspace = await createWorkspace({ repo: readOnly(diskFileSystem(root)), review: { '/diff.patch': 'DIFF' } })
  assert.equal(await workspace.read('/repo/src/a.ts'), 'export const a = 1\n')
  assert.equal((await run(workspace, 'rg -n "const a" src')).stdout, 'src/a.ts:1:export const a = 1\n')
  assert.equal((await run(workspace, 'cat /review/diff.patch')).stdout, 'DIFF')
  await assert.rejects(workspace.write('/repo/src/a.ts', 'x'), /Read-only file system/)
  await assert.rejects(workspace.write('/review/diff.patch', 'x'), /Read-only file system/)
  assert.match((await run(workspace, 'echo x > src/b.ts')).stderr, /Read-only file system/)
  assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'export const a = 1\n')
})

test('paths cannot leave the tree through symlinks, and .git is hidden', async () => {
  const root = tree()
  const workspace = await createWorkspace({ repo: diskFileSystem(root), review: {} })
  assert.equal(await workspace.read('/repo/escape/secret'), null)
  assert.doesNotMatch((await run(workspace, 'ls -a')).stdout, /\.git/)
  await assert.rejects(workspace.write('/repo/escape/secret', 'x'), /EACCES/)
  assert.equal(readFileSync(join(root, 'escape/secret'), 'utf8'), 'key')
})

test('writes never go through symlinks, so links cannot reach protected paths, .git, or outside the tree', async () => {
  const root = tree()
  writeFileSync(join(root, '.git/config'), '[core]\n')
  writeFileSync(join(root, 'package.json'), '{}')
  symlinkSync('package.json', join(root, 'alias'))
  symlinkSync('.git', join(root, 'gitlink'))
  symlinkSync(join(tmpdir(), `factory-missing-${Date.now()}`), join(root, 'dangling'))
  const workspace = await createWorkspace({ repo: diskFileSystem(root, (path) => path === '/package.json'), review: {} })
  await assert.rejects(workspace.write('/repo/alias', 'x'), /EACCES/)
  await assert.rejects(workspace.write('/repo/gitlink/config', 'x'), /ENOENT|EACCES/)
  await assert.rejects(workspace.write('/repo/dangling', 'x'), /EACCES/)
  assert.equal(await workspace.read('/repo/gitlink/config'), null)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{}')
  assert.equal(readFileSync(join(root, '.git/config'), 'utf8'), '[core]\n')
})

test('a writable workspace writes new files and refuses protected paths', async () => {
  const root = tree()
  const workspace = await createWorkspace({ repo: diskFileSystem(root, (path) => path === '/package.json'), review: {} })
  await workspace.write('/repo/src/deep/b.ts', 'export const b = 2\n')
  assert.equal(readFileSync(join(root, 'src/deep/b.ts'), 'utf8'), 'export const b = 2\n')
  await assert.rejects(workspace.write('/repo/package.json', '{}'), /EACCES/)
})

test('the guard keeps the same rails on a virtual file system', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/a.ts': 'a', '/.git/config': '[core]', '/package.json': '{}' } })
  await fs.symlink('package.json', '/alias')
  await fs.symlink('src', '/linked')
  const workspace = await createWorkspace({ repo: guard(fs, (path) => path === '/package.json'), review: {} })
  assert.equal(await workspace.read('/repo/.git/config'), null)
  await assert.rejects(workspace.write('/repo/alias', 'x'), /EACCES/)
  await assert.rejects(workspace.write('/repo/linked/b.ts', 'x'), /EACCES/)
  await assert.rejects(workspace.write('/repo/package.json', 'x'), /EACCES/)
  await workspace.write('/repo/src/b.ts', 'b')
  assert.equal(new TextDecoder().decode(await fs.read('/src/b.ts')), 'b')
  assert.equal(new TextDecoder().decode(await fs.read('/package.json')), '{}')
})

test('a shell with a layout fetch sends curl through that fetch, and a shell without it refuses', async () => {
  const fetched: string[] = []
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    fetched.push(input instanceof Request ? input.url : String(input))
    return new Response('archive page', { headers: { 'content-type': 'text/plain' } })
  }
  const online = await createWorkspace({ repo: MemoryFileSystem.create(), review: {}, fetch })
  const result = await run(online, 'curl -s https://archive.example.org/paper')
  assert.equal(result.stdout, 'archive page')
  assert.deepEqual(fetched, ['https://archive.example.org/paper'])
  const offline = await createWorkspace({ repo: MemoryFileSystem.create(), review: {} })
  const refused = await run(offline, 'curl https://archive.example.org/paper')
  assert.match(refused.stderr, /network access is off in this workspace/, JSON.stringify(refused))
  assert.notEqual(refused.exit_code, 0)
  assert.equal(fetched.length, 1)
})

test('an agent shell with hostFetch sends curl through the egress: it stores the artifact, and refuses a locked URL and an unlisted host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-ws-egress-'))
  const fetched: string[] = []
  const artifacts = memoryArtifacts()
  const ledger = fileLedger(join(dir, 'state.json'))
  const host: AgentHost = {
    module,
    store: sqliteStore(join(dir, 'agents.sqlite'), join(dir, 'agents')),
    ledger,
    credentials,
    log: () => {},
    egress: {
      artifacts,
      lock: runLock(ledger, ['https://archive.example.org/holdout/']),
      secret: () => undefined,
      fetch: async (input: string | URL | Request): Promise<Response> => {
        fetched.push(input instanceof Request ? input.url : String(input))
        return new Response('archive page', { headers: { 'content-type': 'text/plain' } })
      },
    },
  }
  const shellFetch = hostFetch('researcher', { hosts: ['archive.example.org'], web_search: false }, host)
  const workspace = await createWorkspace({ repo: MemoryFileSystem.create(), review: {}, fetch: shellFetch })

  const result = await run(workspace, 'curl -s https://archive.example.org/paper')
  assert.equal(result.stdout, 'archive page', JSON.stringify(result))
  assert.deepEqual(fetched, ['https://archive.example.org/paper'])
  const listed = await artifacts.list()
  assert.equal(listed.length, 2)
  const body = listed.find(({ meta }) => 'url' in meta.source)
  assert.ok(body)
  assert.deepEqual(body.meta.source, { url: 'https://archive.example.org/paper', method: 'GET' })
  assert.equal(body.meta.labels.status, '200')
  assert.equal(new TextDecoder().decode((await artifacts.get(body.id)) ?? new Uint8Array()), 'archive page')
  const provenance = listed.find(({ meta }) => 'command' in meta.source)
  assert.ok(provenance)
  assert.deepEqual(provenance.meta.source, { command: 'egress provenance' })
  assert.equal(provenance.meta.labels.body, body.id)
  const record = JSON.parse(new TextDecoder().decode((await artifacts.get(provenance.id)) ?? new Uint8Array()))
  assert.equal(record.body, body.id)
  assert.equal(record.url, 'https://archive.example.org/paper')
  assert.equal(record.method, 'GET')

  const locked = await run(workspace, 'curl https://archive.example.org/holdout/answers')
  assert.match(locked.stderr, /egress refused: lock: .*holdout\/answers is locked/, JSON.stringify(locked))
  assert.notEqual(locked.exit_code, 0)
  const unlisted = await run(workspace, 'curl https://evil.example.net/x')
  assert.match(unlisted.stderr, /egress refused: host evil\.example\.net is not in the list/, JSON.stringify(unlisted))
  assert.notEqual(unlisted.exit_code, 0)
  // The refused requests do not reach the network and store nothing.
  assert.equal(fetched.length, 1)
  assert.equal((await artifacts.list()).length, 2)
})
