import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { createWorkspace, guard, readOnly } from '../src/core/workspace.ts'
import { diskFileSystem } from '../src/node/disk.ts'

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
