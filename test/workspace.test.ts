import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { hostFetch, type AgentHost } from '../src/core/agent.ts'
import { runLock } from '../src/core/egress.ts'
import { allowFiles, createWorkspace, fileHash, guard, readOnly, recordEdits } from '../src/core/workspace.ts'
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

test('disk lstat reads the final link but refuses hidden paths and parents outside the tree', async () => {
  const root = tree()
  writeFileSync(join(root, '.git/config'), '[core]\n')
  symlinkSync('src', join(root, 'linked'))
  symlinkSync('missing', join(root, 'dangling'))
  symlinkSync('.git', join(root, 'gitlink'))
  const fs = diskFileSystem(root)
  for (const path of ['/linked', '/dangling', '/escape', '/gitlink']) {
    assert.equal((await fs.lstat?.(path))?.kind, 'symlink', path)
  }
  assert.equal((await fs.lstat?.('/'))?.kind, 'directory')
  assert.equal((await fs.lstat?.('/linked/a.ts'))?.kind, 'file')
  for (const path of ['/escape/secret', '/.git', '/.git/config', '/gitlink/config', '/missing']) {
    assert.equal(await fs.lstat?.(path), null, path)
  }
  await assert.rejects(fs.read('/escape/secret'), /EACCES/)
  // The message of a file system error names the cause in words, so the check reads its code.
  await assert.rejects(fs.read('/gitlink/config'), (error: unknown) => (error as { code?: string }).code === 'ENOENT')
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

test('an edit record keeps each written, removed and renamed path in the ledger, and no refused change', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/a.ts': 'a', '/src/b.ts': 'b', '/docs/c.md': 'c', '/package.json': '{}' } })
  const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
  const open = () => createWorkspace({ repo: recordEdits(allowFiles(guard(fs), (path) => path !== 'package.json'), ledger, 'edits:patch'), review: {} })
  const workspace = await open()
  await workspace.write('/repo/src/a.ts', 'x')
  await workspace.write('/repo/src/a.ts', 'y')
  await assert.rejects(workspace.write('/repo/package.json', 'x'), /EACCES/)
  await run(workspace, 'rm src/b.ts')
  assert.deepEqual(ledger.get('edits:patch'), ['src/a.ts', 'src/b.ts'])

  // A new workspace on the same ledger, as in a resumed turn, adds to the paths of the turn before.
  await run(await open(), 'mv docs/c.md docs/d.md')
  assert.deepEqual(ledger.get('edits:patch'), ['src/a.ts', 'src/b.ts', 'docs/c.md', 'docs/d.md'])
})

test('an edit record keeps each file of a renamed or removed directory, so that the gate finds their tests', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/old/a.ts': 'a', '/src/old/sub/b.ts': 'b', '/lib/c.ts': 'c', '/lib/d.ts': 'd' } })
  const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
  const repo = recordEdits(guard(fs), ledger, 'edits:patch')
  await repo.rename('/src/old', '/src/new')
  assert.deepEqual([...(ledger.get<string[]>('edits:patch') ?? [])].sort(), ['src/new/a.ts', 'src/new/sub/b.ts', 'src/old/a.ts', 'src/old/sub/b.ts'])

  await run(await createWorkspace({ repo, review: {} }), 'rm -r lib')
  assert.equal(await fs.stat('/lib/c.ts'), null)
  assert.deepEqual(
    [...(ledger.get<string[]>('edits:patch') ?? [])].sort(),
    ['lib/c.ts', 'lib/d.ts', 'src/new/a.ts', 'src/new/sub/b.ts', 'src/old/a.ts', 'src/old/sub/b.ts'],
  )
})

test('an edit record keeps the first hashes of both directory rename paths, including absent destination children', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/old/a.ts': 'a', '/src/old/sub/b.ts': 'b' } })
  const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
  const repo = recordEdits(guard(fs), ledger, 'edits:patch', 'originals:patch')
  const originals = {
    'src/old/a.ts': await fileHash(fs, '/src/old/a.ts'),
    'src/new/a.ts': null,
    'src/old/sub/b.ts': await fileHash(fs, '/src/old/sub/b.ts'),
    'src/new/sub/b.ts': null,
  }
  await repo.rename('/src/old', '/src/new')
  assert.deepEqual(ledger.get('originals:patch'), originals)
  await repo.rename('/src/new', '/src/old')
  assert.deepEqual(ledger.get('originals:patch'), originals)
  for (const [path, hash] of Object.entries(originals)) assert.equal(await fileHash(fs, `/${path}`), hash)
})

test('an edit record keeps concurrent first hashes without another file read, also after a resume', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/a.ts': 'a', '/src/b.ts': 'b' } })
  const reads: string[] = []
  const counted = {
    ...fs,
    read: async (path: string) => {
      reads.push(path)
      return fs.read(path)
    },
  }
  const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
  const open = () => recordEdits(guard(counted), ledger, 'edits:patch', 'originals:patch')
  const a = await fileHash(fs, '/src/a.ts')
  const b = await fileHash(fs, '/src/b.ts')
  await Promise.all([open().write('/src/a.ts', new TextEncoder().encode('x')), open().write('/src/b.ts', new TextEncoder().encode('z'))])
  await open().write('/src/a.ts', new TextEncoder().encode('y'))
  await open().write('/src/new.ts', new TextEncoder().encode('new'))
  await open().write('/src/new.ts', new TextEncoder().encode('changed'))
  // A file system removes one empty directory at a time, so the files go first, as `rm -r` removes them.
  for (const file of ['/src/a.ts', '/src/b.ts', '/src/new.ts']) await open().remove(file)
  await open().remove('/src')
  assert.deepEqual(reads.sort(), ['/src/a.ts', '/src/b.ts'])
  assert.deepEqual(ledger.get('originals:patch'), { 'src/a.ts': a, 'src/new.ts': null, 'src/b.ts': b })
})

test('an edit record follows no parent or external symlink, and records nothing for a refused removal', async () => {
  const fs = MemoryFileSystem.create({ files: { '/src/a.ts': 'a', '/outside/secret': 'secret' } })
  await fs.symlink('..', '/src/parent')
  await fs.symlink('/outside', '/src/external')
  const reads: string[] = []
  const counted = {
    ...fs,
    read: async (path: string) => {
      reads.push(path)
      return fs.read(path)
    },
  }
  const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
  const repo = recordEdits(guard(counted), ledger, 'edits:patch', 'originals:patch')
  // As `rm -r` does: each entry first. The guard refuses to remove a link, so the agent cannot remove the directory.
  await repo.remove('/src/a.ts')
  await assert.rejects(repo.remove('/src/parent'), /EACCES/)
  await assert.rejects(repo.remove('/src/external'), /EACCES/)
  assert.deepEqual(reads, ['/src/a.ts'])
  assert.deepEqual(ledger.get<string[]>('edits:patch'), ['src/a.ts'])
  assert.equal(new TextDecoder().decode(await fs.read('/outside/secret')), 'secret')
})

for (const operation of ['rename', 'remove']) {
  test(`a disk edit record stops at parent and sibling symlinks during directory ${operation}`, async () => {
    const root = tree()
    mkdirSync(join(root, 'sibling'))
    writeFileSync(join(root, 'sibling/other.ts'), 'other')
    symlinkSync('..', join(root, 'src/parent'))
    symlinkSync('../sibling', join(root, 'src/sibling'))
    const fs = diskFileSystem(root)
    const reads: string[] = []
    const counted = {
      ...fs,
      list: async (path: string) => {
        assert.equal(path, '/src')
        return fs.list(path)
      },
      read: async (path: string) => {
        reads.push(path)
        return fs.read(path)
      },
    }
    const ledger = fileLedger(join(mkdtempSync(join(tmpdir(), 'factory-edits-')), 'state.json'))
    const repo = recordEdits(counted, ledger, 'edits:patch', 'originals:patch')
    const paths = ['src/a.ts', 'src/parent', 'src/sibling']
    const originals: Record<string, string | null> = {}
    for (const path of paths) originals[path] = await fileHash(fs, `/${path}`)
    if (operation === 'rename') {
      for (const path of paths) originals[path.replace('src/', 'dest/')] = null
      await repo.rename('/src', '/dest')
    } else {
      await repo.remove('/src')
    }
    assert.deepEqual(reads, ['/src/a.ts'])
    assert.deepEqual([...(ledger.get<string[]>('edits:patch') ?? [])].sort(), Object.keys(originals).sort())
    assert.deepEqual(ledger.get('originals:patch'), originals)
    assert.equal(await fs.stat('/src'), null)
    assert.equal(readFileSync(join(root, 'sibling/other.ts'), 'utf8'), 'other')
    if (operation === 'rename') {
      assert.equal(readFileSync(join(root, 'dest/a.ts'), 'utf8'), 'export const a = 1\n')
      assert.equal((await fs.lstat?.('/dest/parent'))?.kind, 'symlink')
      assert.equal((await fs.lstat?.('/dest/sibling'))?.kind, 'symlink')
    }
  })
}

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
