import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import type { Contracts } from 'nanocode-ts'
import type { FileSystem } from 'nanocode-ts/bash'
import { sqlBranches } from '../src/cloudflare/branches.ts'
import { github } from '../src/cloudflare/github.ts'
import type { Ledger } from '../src/core/ledger.ts'
import { hasConflictMarkers } from '../src/core/merge.ts'
import { git } from '../src/node/git.ts'
import { moveBase, parents } from './support/base-merge.ts'
import { developRepo } from './support/develop.ts'
import { mockServices } from './support/mock-services.ts'

const read = async (tree: FileSystem.FileSystem, path: string) => new TextDecoder().decode(await tree.read(path))
const write = (tree: FileSystem.FileSystem, path: string, text: string) => tree.write(path, new TextEncoder().encode(text))

/** Durable Object SQL over node:sqlite: blobs go in and come out as ArrayBuffer. */
function sqlHost(): Contracts.SqlHost {
  const db = new DatabaseSync(':memory:')
  const input = (value: unknown) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue
  const output = (value: unknown) => (value instanceof Uint8Array ? new Uint8Array(value).buffer : value)
  return {
    transaction(_kind, _operation, statements) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const rows = statements.map(([query, ...values]) => {
          const statement = db.prepare(query)
          statement.setReturnArrays(true)
          return (statement.all(...values.map(input)) as unknown as unknown[][]).map((row) => row.map(output))
        })
        db.exec('COMMIT')
        return rows as Contracts.SqlValue[][][]
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function memoryLedger(): Ledger {
  const values = new Map<string, unknown>()
  return { get: <T>(key: string) => values.get(key) as T | undefined, put: (key, value) => void values.set(key, structuredClone(value)) }
}

/** Run branches in SQL over the mock GitHub, whose repository is the origin, and a run branch with a change to src/math.ts, pushed. */
async function changedBranch(t: { after(fn: () => Promise<void>): void }) {
  const { repo, origin } = developRepo()
  const mock = await mockServices(origin, {
    botLogin: 'factory-bot',
    name: 'app',
    owner: 'acme',
    script: () => {
      throw new Error('this test has no model turns')
    },
  })
  t.after(() => mock.close())
  const branches = sqlBranches({ gh: github('token', mock.url), ledger: memoryLedger(), log: () => {}, owner: 'acme', repo: 'app', run: 'run-1', sql: sqlHost() })
  const start = (await git(origin, 'rev-parse', 'main')).trim()
  await branches.view(start)
  const branch = await branches.branch('factory/dev-x', start)
  await write(branch.tree, '/src/math.ts', 'export const add = (a: number, b: number) => a + b\n')
  await branch.commit('change add')
  const before = await branches.push(branch)
  return { repo, origin, branches, branch, start, before }
}

test('Cloudflare branches: a clean base merge makes a merge commit with two parents on GitHub', async (t) => {
  const { repo, origin, branches, branch, start, before } = await changedBranch(t)
  const baseHead = moveBase(repo, { 'src/other.ts': 'export const other = 1\n' })
  assert.equal(await branches.remoteHead('main'), baseHead)
  assert.equal(await branch.mergeBaseWith(baseHead), start)

  assert.deepEqual(await branch.mergeCommit(baseHead, 'merge main'), { files: ['src/other.ts'], conflicts: [] })
  const merged = (await git(origin, 'rev-parse', 'refs/heads/factory/dev-x')).trim()
  assert.deepEqual(parents(origin, merged), [before, baseHead])
  assert.equal(await read(branch.tree, '/src/other.ts'), 'export const other = 1\n')
  // The local head stands for the GitHub merge commit, so the push changes nothing.
  assert.equal(await branches.push(branch), merged)
  assert.equal(await branch.mergeBaseWith(baseHead), baseHead)
  assert.deepEqual(await branch.changedFiles(baseHead, await branch.head()), ['src/math.ts'])

  // A local head that is not pushed adds its own changes to the compare of GitHub.
  await write(branch.tree, '/src/mul.ts', 'export const mul = (a: number, b: number) => a * b\n')
  await branch.commit('add mul')
  assert.deepEqual((await branch.changedFiles(baseHead, await branch.head())).sort(), ['src/math.ts', 'src/mul.ts'])
  assert.deepEqual((await branch.touchedFiles(baseHead, await branch.head())).sort(), ['src/math.ts', 'src/mul.ts'])
})

test('Cloudflare branches: a conflict writes markers, and the resolved push makes a GitHub commit with two parents', async (t) => {
  const { repo, origin, branches, branch, before } = await changedBranch(t)
  const baseHead = moveBase(repo, { 'src/math.ts': 'export function add(a: number, b: number): number {\n  return b + a\n}\n', 'src/other.ts': 'export const other = 1\n' })

  assert.deepEqual(await branch.mergeCommit(baseHead, 'merge main'), { files: ['src/math.ts', 'src/other.ts'], conflicts: ['src/math.ts'] })
  const marked = await read(branch.tree, '/src/math.ts')
  assert.ok(hasConflictMarkers(marked))
  assert.match(marked, /a \+ b/)
  assert.match(marked, /return b \+ a/)
  assert.equal(await read(branch.tree, '/src/other.ts'), 'export const other = 1\n')
  // GitHub has no merge until the push.
  assert.equal((await git(origin, 'rev-parse', 'refs/heads/factory/dev-x')).trim(), before)
  assert.deepEqual(await branch.finishMerge(['src/math.ts'], 'merge main'), ['src/math.ts'])

  await write(branch.tree, '/src/math.ts', 'export const add = (a: number, b: number) => b + a\n')
  await branch.pending()
  await branch.commit('agent-factory: checkpoint')
  assert.deepEqual(await branch.finishMerge(['src/math.ts'], 'merge main'), [])
  const merged = await branches.push(branch)
  assert.deepEqual(parents(origin, merged), [before, baseHead])
  assert.equal((await git(origin, 'show', `${merged}:src/math.ts`)), 'export const add = (a: number, b: number) => b + a\n')
  assert.equal((await git(origin, 'show', `${merged}:src/other.ts`)), 'export const other = 1\n')
  assert.equal(await branch.mergeBaseWith(baseHead), baseHead)
  assert.deepEqual(await branch.changedFiles(baseHead, await branch.head()), ['src/math.ts'])

  // The push ended the merge: the next commit has one parent.
  await write(branch.tree, '/src/mul.ts', 'export const mul = (a: number, b: number) => a * b\n')
  await branch.commit('add mul')
  assert.deepEqual(parents(origin, await branches.push(branch)), [merged])
})

test('Cloudflare branches: a resolved merge with the tree of the head makes a GitHub commit with two parents', async (t) => {
  const { repo, origin, branches, branch, before } = await changedBranch(t)
  const mine = await read(branch.tree, '/src/math.ts')
  const baseHead = moveBase(repo, { 'src/math.ts': 'export function add(a: number, b: number): number {\n  return b + a\n}\n' })

  assert.deepEqual(await branch.mergeCommit(baseHead, 'merge main'), { files: ['src/math.ts'], conflicts: ['src/math.ts'] })
  await write(branch.tree, '/src/math.ts', mine)
  assert.deepEqual((await branch.pending()).changed, [])
  assert.deepEqual(await branch.finishMerge(['src/math.ts'], 'merge main'), [])
  const merged = await branches.push(branch)
  assert.deepEqual(parents(origin, merged), [before, baseHead])
  assert.equal(await git(origin, 'show', `${merged}:src/math.ts`), mine)
  assert.equal(await branch.mergeBaseWith(baseHead), baseHead)
})

test('Cloudflare branches: a base merge stops when GitHub has a commit that the run did not push', async (t) => {
  const { repo, origin, branches, branch, before } = await changedBranch(t)
  const baseHead = moveBase(repo, { 'src/other.ts': 'export const other = 1\n' })
  const tree = (await git(origin, 'rev-parse', `${before}^{tree}`)).trim()
  const foreign = (await git(origin, '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit-tree', tree, '-p', before, '-m', 'foreign')).trim()
  await git(origin, 'update-ref', 'refs/heads/factory/dev-x', foreign)
  await assert.rejects(branch.mergeCommit(baseHead, 'merge main'), /not the pushed head/)
  assert.equal((await git(origin, 'rev-parse', 'refs/heads/factory/dev-x')).trim(), foreign)
})
