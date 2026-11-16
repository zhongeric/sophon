import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import type { SqlValue } from '../src/cloudflare/artifacts.ts'
import { boxMachine, containerBox, syncTree, syncWithSetup, type Box } from '../src/cloudflare/box.ts'
import { createSyncTables, sqlSyncs, type SyncSql } from '../src/cloudflare/syncs.ts'

/** Durable Object SQL over node:sqlite. A new store over the same database is a new object after a restart. */
function fakeSql(): SyncSql {
  const db = new DatabaseSync(':memory:')
  const sql: SyncSql = {
    exec(query, ...bindings) {
      const rows: unknown[] = db.prepare(query).all(...bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)))
      return {
        toArray: () =>
          rows.map((row) => {
            if (typeof row !== 'object' || row === null) throw new Error('unexpected SQL row')
            return Object.fromEntries(Object.entries(row).map(([key, value]): [string, SqlValue] => [key, typeof value === 'string' || typeof value === 'number' || value === null ? value : String(value)]))
          }),
      }
    },
  }
  createSyncTables(sql)
  return sql
}

/** A machine whose root is a local directory, so that a test can look at what the sync wrote. */
function localBox(root: string, commands: string[]): Box {
  return {
    async start() {},
    async exec(argv, { cwd, stdin }) {
      commands.push(argv.join(' '))
      mkdirSync(join(root, cwd), { recursive: true })
      const result = spawnSync(argv[0]!, argv.slice(1), { cwd: join(root, cwd), input: stdin ? Buffer.from(stdin) : undefined })
      return { exit_code: result.status, output: `${result.stdout}${result.stderr}` }
    },
  }
}

test('a sync copies the whole tree without .git, then only what changed or went away, and keeps what the setup installed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-box-'))
  const commands: string[] = []
  const box = localBox(root, commands)
  const tree = MemoryFileSystem.create({ files: { '/.git/HEAD': 'ref', '/a.txt': 'a', '/src/b.ts': 'b' } })
  const dir = join(root, 'work/x')

  const first = await syncTree(box, tree, 'work/x', null)
  assert.deepEqual([readFileSync(join(dir, 'a.txt'), 'utf8'), readFileSync(join(dir, 'src/b.ts'), 'utf8'), existsSync(join(dir, '.git'))], ['a', 'b', false])
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules/keep'), 'installed')

  await tree.write('/a.txt', new TextEncoder().encode('changed'))
  await tree.remove('/src/b.ts')
  await tree.write('/c.txt', new TextEncoder().encode('new'))
  commands.length = 0
  await syncTree(box, tree, 'work/x', first)
  assert.deepEqual(commands, ['bash -c xargs -0 rm -f --', 'tar -x -f -'])
  assert.deepEqual(
    [readFileSync(join(dir, 'a.txt'), 'utf8'), existsSync(join(dir, 'src/b.ts')), readFileSync(join(dir, 'c.txt'), 'utf8'), readFileSync(join(dir, 'node_modules/keep'), 'utf8')],
    ['changed', false, 'new', 'installed'],
  )
})

/** A container whose root is a local directory. It comes back empty when it starts, as a stopped Cloudflare Container does. */
function localContainer(root: string, exitCode?: number) {
  const container = {
    running: false,
    start() {
      rmSync(root, { force: true, recursive: true })
      mkdirSync(root, { recursive: true })
      container.running = true
    },
    async setInactivityTimeout() {},
    async exec(argv: string[], options: { cwd: string; stdin?: ReadableStream }) {
      // The box wraps each command in timeout -k 10 <seconds>.
      const command = argv.slice(4)
      const cwd = join(root, options.cwd)
      const input = options.stdin ? Buffer.from(await new Response(options.stdin).arrayBuffer()) : undefined
      const result = existsSync(cwd) ? spawnSync(command[0]!, command.slice(1), { cwd, input }) : { status: 1, stdout: '', stderr: `no directory ${options.cwd}` }
      return { stdout: new Blob([`${result.stdout}${result.stderr}`]).stream(), exitCode: Promise.resolve(exitCode ?? result.status ?? 1) }
    },
  }
  return container
}

test('a sync after the container stopped copies all of the tree and runs the setup again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-container-'))
  const container = localContainer(root)
  const sql = fakeSql()
  const store = sqlSyncs(sql, 'run-1')
  const box = containerBox(container, { inactivityMs: 60_000, onStart: () => store.clear() })
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a' } })
  const setup = { command: 'echo installed >> setup.txt', timeoutMs: 60_000 }
  const lines: string[] = []
  const machine = boxMachine(box, 'work/x', () => syncWithSetup(box, store, tree, 'work/x', setup, (line) => lines.push(line)))
  const check = () => machine.run('cat a.txt setup.txt', { env: [], timeoutMs: 60_000 })

  assert.deepEqual(await check(), { exit_code: 0, output: 'ainstalled\n' })
  // Another run of the same object shares the container, so a start clears its state too.
  sqlSyncs(sql, 'run-2').save('work/y', { files: new Map([['b.txt', 'stamp']]), sync: 'other' })
  // The container stops after inactivity, while the object still knows what the directory held.
  container.running = false
  await box.start()
  assert.deepEqual([store.read('work/x'), sqlSyncs(sql, 'run-2').read('work/y'), sql.exec('select * from factory_sync_files').toArray()], [null, null, []])
  assert.deepEqual(await check(), { exit_code: 0, output: 'ainstalled\n' })
  assert.match(lines.at(-2) ?? '', /^sync work\/x: full, 1 files sent in \d+ ms$/)
  assert.match(lines.at(-1) ?? '', /^setup work\/x: pass in \d+ ms$/)
})

/** A machine with a branch directory work/x, a setup that counts its runs, and a store over SQL that outlives a store object. */
function syncFixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'))
  const commands: string[] = []
  const lines: string[] = []
  const box = localBox(root, commands)
  const sql = fakeSql()
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a', '/src/b.ts': 'b' } })
  const setup = { command: 'test ! -f ../../fail && echo run >> setup.log', timeoutMs: 60_000 }
  const fixture = {
    commands,
    lines,
    root,
    sql,
    store: sqlSyncs(sql, 'run-1'),
    tree,
    dir: join(root, 'work/x'),
    marker: join(root, 'work/x.sync'),
    sync: () => syncWithSetup(box, fixture.store, tree, 'work/x', setup, (line) => lines.push(line)),
    setupRuns: () => readFileSync(join(root, 'work/x/setup.log'), 'utf8').split('\n').filter(Boolean).length,
    full: () => commands.some((command) => command.includes('rm -rf')),
  }
  return fixture
}

test('a sync after a restart of the object sends only the changes and runs no setup', async () => {
  const fixture = syncFixture()
  await fixture.sync()
  assert.equal(fixture.setupRuns(), 1)

  await fixture.tree.write('/a.txt', new TextEncoder().encode('changed'))
  // A new object reads the state from the same SQL. The container still runs.
  fixture.store = sqlSyncs(fixture.sql, 'run-1')
  fixture.commands.length = 0
  await fixture.sync()
  assert.equal(fixture.full(), false)
  assert.deepEqual(fixture.commands.map((command) => command.split(' ')[0]), ['bash', 'tar', 'bash'])
  assert.equal(readFileSync(join(fixture.dir, 'a.txt'), 'utf8'), 'changed')
  assert.equal(fixture.setupRuns(), 1)
  assert.match(fixture.lines.at(-1) ?? '', /^sync work\/x: changes, 1 files sent in \d+ ms$/)

  // Nothing changed: the sync only checks the marker and writes nothing.
  const marker = readFileSync(fixture.marker, 'utf8')
  fixture.commands.length = 0
  await fixture.sync()
  assert.equal(fixture.commands.length, 1)
  assert.doesNotMatch(fixture.commands[0]!, /rm -f/)
  assert.equal(readFileSync(fixture.marker, 'utf8'), marker)
  assert.match(fixture.lines.at(-1) ?? '', /^sync work\/x: changes, 0 files sent in \d+ ms$/)
})

test('a missing or a different marker gives a full copy and the setup', async () => {
  for (const change of [(marker: string) => rmSync(marker), (marker: string) => writeFileSync(marker, 'other')]) {
    const fixture = syncFixture()
    await fixture.sync()
    writeFileSync(join(fixture.dir, 'stale.txt'), 'stale')
    change(fixture.marker)
    fixture.commands.length = 0
    await fixture.sync()
    assert.equal(fixture.full(), true)
    assert.equal(existsSync(join(fixture.dir, 'stale.txt')), false)
    // The full copy removed setup.log, so one line shows that the setup ran again.
    assert.equal(fixture.setupRuns(), 1)
    assert.match(fixture.lines.at(-1) ?? '', /^setup work\/x: pass in \d+ ms$/)
  }
})

test('a failed setup leaves no valid state, so the next sync is full and runs the setup again', async () => {
  const fixture = syncFixture()
  writeFileSync(join(fixture.root, 'fail'), '')
  await assert.rejects(fixture.sync(), /the setup command failed/)
  assert.equal(fixture.store.read('work/x'), null)
  assert.equal(existsSync(fixture.marker), false)
  assert.match(fixture.lines.at(-1) ?? '', /^setup work\/x: fail in \d+ ms$/)

  rmSync(join(fixture.root, 'fail'))
  fixture.commands.length = 0
  await fixture.sync()
  assert.equal(fixture.full(), true)
  assert.equal(fixture.setupRuns(), 1)
})

test('a sync with changes removes the marker before its first write, so a failed copy leaves no valid state', async () => {
  const fixture = syncFixture()
  await fixture.sync()
  // A file in place of the src directory makes the tar of the changes fail.
  rmSync(join(fixture.dir, 'src'), { recursive: true })
  writeFileSync(join(fixture.dir, 'src'), 'not a directory')
  await fixture.tree.write('/src/b.ts', new TextEncoder().encode('changed'))
  await assert.rejects(fixture.sync(), /syncing work\/x failed/)
  assert.equal(fixture.store.read('work/x'), null)
  assert.equal(existsSync(fixture.marker), false)
})

test('the marker is beside the directory and holds the stored sync ID', async () => {
  const fixture = syncFixture()
  await fixture.sync()
  assert.equal(readFileSync(fixture.marker, 'utf8'), fixture.store.read('work/x')?.sync)
  assert.deepEqual(readdirSync(fixture.dir).sort(), ['a.txt', 'setup.log', 'src'])
  assert.deepEqual([...(fixture.store.read('work/x')?.files.keys() ?? [])].sort(), ['a.txt', 'src/b.ts'])
})

test('exit code 137 before the time limit is a kill, not a timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-container-'))
  const killed = await containerBox(localContainer(root, 137), { inactivityMs: 60_000, onStart: () => {} }).exec(['true'], { cwd: '', env: {}, timeoutMs: 60_000 })
  assert.equal(killed.exit_code, 137)
  assert.match(killed.output, /killed before its time limit/)
  const timedOut = await containerBox(localContainer(root, 124), { inactivityMs: 60_000, onStart: () => {} }).exec(['true'], { cwd: '', env: {}, timeoutMs: 60_000 })
  assert.equal(timedOut.exit_code, null)
  assert.match(timedOut.output, /killed after 60000 ms/)
})
