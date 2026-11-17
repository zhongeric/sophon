import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import type { SqlValue } from '../src/cloudflare/artifacts.ts'
import { artifactSizeLimit } from '../src/core/artifacts.ts'
import { boxMachine, cleanBox, containerBox, SetupError, syncTree, syncWithSetup, type Box } from '../src/cloudflare/box.ts'
import { reviewChecker } from '../src/cloudflare/checker.ts'
import { createSyncTables, sqlSyncs, type SyncSql } from '../src/cloudflare/syncs.ts'
import { commandChecker } from '../src/core/checks.ts'
import type { Checker } from '../src/core/platform.ts'

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
  const pending = new Map<string, Promise<void>>()
  const machine = boxMachine(box, 'work/x', () => syncWithSetup(box, store, pending, tree, 'work/x', setup, (line) => lines.push(line)))
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
  assert.match(lines.at(-1) ?? '', /^setup work\/x: pass, 1 files in \d+ ms$/)
})

/**
 * A machine with a branch directory work/x, a setup that counts its runs, and a store over SQL that outlives a store
 * object. When `failTar` is true, each tar command on the machine fails. Thus the test does not depend on the tar
 * of the host.
 */
function syncFixture() {
  const root = mkdtempSync(join(tmpdir(), 'factory-sync-'))
  const commands: string[] = []
  const lines: string[] = []
  const local = localBox(root, commands)
  const box: Box = {
    start: () => local.start(),
    async exec(argv, options) {
      if (fixture.failTar && argv[0] === 'tar') {
        commands.push(argv.join(' '))
        return { exit_code: 1, output: 'tar: write error' }
      }
      return local.exec(argv, options)
    },
  }
  const sql = fakeSql()
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a', '/src/b.ts': 'b' } })
  const setup = { command: 'test ! -f ../../fail && echo run >> setup.log', timeoutMs: 60_000 }
  const pending = new Map<string, Promise<void>>()
  const fixture = {
    failTar: false,
    box,
    commands,
    lines,
    pending,
    root,
    sql,
    store: sqlSyncs(sql, 'run-1'),
    tree,
    dir: join(root, 'work/x'),
    marker: join(root, 'work/x.sync'),
    sync: () => syncWithSetup(box, fixture.store, pending, tree, 'work/x', setup, (line) => lines.push(line)),
    setupRuns: () => readFileSync(join(root, 'work/x/setup.log'), 'utf8').split('\n').filter(Boolean).length,
    full: () => commands.some((command) => command.includes('rm -rf')),
  }
  return fixture
}

test('two concurrent syncs of one directory make one full copy and run the setup once', async () => {
  const fixture = syncFixture()
  await Promise.all([fixture.sync(), fixture.sync()])

  assert.equal(fixture.commands.filter((command) => command.includes('rm -rf')).length, 1)
  assert.equal(fixture.commands.filter((command) => command === 'tar -x -f -').length, 1)
  assert.equal(fixture.lines.filter((line) => line.startsWith('setup work/x:')).length, 1)
  assert.equal(fixture.setupRuns(), 1)
  assert.equal(readFileSync(join(fixture.dir, 'a.txt'), 'utf8'), 'a')
  assert.equal(readFileSync(join(fixture.dir, 'src/b.ts'), 'utf8'), 'b')
  assert.equal(readFileSync(fixture.marker, 'utf8'), fixture.store.read('work/x')?.sync)
  assert.match(fixture.lines.at(-1) ?? '', /^sync work\/x: changes, 0 files sent in \d+ ms$/)
  assert.equal(fixture.pending.size, 0)
})

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
    assert.match(fixture.lines.at(-1) ?? '', /^setup work\/x: pass, 2 files in \d+ ms$/)
  }
})

test('a failed setup leaves no valid state, so the next sync is full and runs the setup again', async () => {
  const fixture = syncFixture()
  writeFileSync(join(fixture.root, 'fail'), '')
  await assert.rejects(fixture.sync(), (error) => error instanceof SetupError && /the setup command failed/.test(error.message) && error.result.exit_code === 1)
  assert.equal(fixture.store.read('work/x'), null)
  assert.equal(existsSync(fixture.marker), false)
  assert.match(fixture.lines.at(-1) ?? '', /^setup work\/x: fail, 2 files in \d+ ms$/)

  rmSync(join(fixture.root, 'fail'))
  fixture.commands.length = 0
  await fixture.sync()
  assert.equal(fixture.full(), true)
  assert.equal(fixture.setupRuns(), 1)
})

test('the checker of a review run keeps CI as its checks, and gives a failed setup on the machine as a failed result named setup', async () => {
  const fixture = syncFixture()
  writeFileSync(join(fixture.root, 'fail'), '')
  const config = { stack: 'TypeScript', checks: { smoke: 'true' }, tests: { pattern: '\\.test\\.ts$', command: 'node --test {tests}' } }
  const ci: Checker = { checks: async () => [], tests: null }
  const checker = reviewChecker(ci, commandChecker({ committedFiles: async () => [], tree: fixture.tree }, config, boxMachine(fixture.box, 'work/x', fixture.sync)))
  assert.equal(checker.checks, ci.checks)
  const failed = { command: 'test ! -f ../../fail && echo run >> setup.log', exit_code: 1, name: 'setup', output: '', status: 'fail' }
  assert.deepEqual(await checker.tests!(['test/a.test.ts']), [failed])
  assert.deepEqual(await checker.agentChecks!([]), [failed])

  // Other errors of the sync still stop the call.
  rmSync(join(fixture.root, 'fail'))
  fixture.failTar = true
  await assert.rejects(checker.tests!(['test/a.test.ts']), /syncing work\/x failed/)
})

test('a sync with changes removes the marker before its first write, so a failed copy leaves no valid state', async () => {
  const fixture = syncFixture()
  await fixture.sync()
  assert.equal(existsSync(fixture.marker), true)
  fixture.failTar = true
  await fixture.tree.write('/src/b.ts', new TextEncoder().encode('changed'))
  await assert.rejects(fixture.sync(), /syncing work\/x failed/)
  assert.equal(fixture.commands.at(-1), 'tar -x -f -')
  assert.match(fixture.lines.at(-1) ?? '', /^sync work\/x: changes, 1 files failed in \d+ ms$/)
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

test('a clean box copies only the tree, runs no setup, and runs its commands in the directory without a sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-clean-'))
  const commands: string[] = []
  const lines: string[] = []
  const tree = MemoryFileSystem.create({ files: { '/.git/HEAD': 'ref', '/a.txt': 'a', '/src/b.ts': 'b' } })
  const box = await cleanBox(localBox(root, commands), tree, 'clean-1', (line) => lines.push(line))
  const dir = join(root, 'clean-1')

  assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'src'])
  assert.equal(readFileSync(join(dir, 'src/b.ts'), 'utf8'), 'b')
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /^sync clean-1: full, 2 files sent in \d+ ms$/)
  commands.length = 0
  assert.deepEqual(await box.run('cat a.txt && pwd -P', { env: [], timeoutMs: 60_000 }), { exit_code: 0, output: `a${realpathSync(dir)}\n` })
  assert.deepEqual(commands, ['bash -c cat a.txt && pwd -P'])
})

test('a clean box reads the exact bytes of a file, and refuses a path outside its directory or a missing file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-clean-'))
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a' } })
  const box = await cleanBox(localBox(root, []), tree, 'clean-1', () => {})
  const dir = join(root, 'clean-1')
  const binary = Uint8Array.from({ length: 256 }, (_, index) => index)
  // Over two chunks, with every byte value, so that a wrong offset or a lost byte changes the result.
  const large = Uint8Array.from({ length: 40_000 }, (_, index) => (index * 7 + (index >> 8)) % 256)
  mkdirSync(join(dir, 'out'))
  writeFileSync(join(dir, 'out/binary.bin'), binary)
  writeFileSync(join(dir, 'out/large.bin'), large)
  writeFileSync(join(dir, 'empty'), '')
  writeFileSync(join(root, 'x'), 'outside')
  symlinkSync(join(root, 'x'), join(dir, 'link'))
  symlinkSync('out/binary.bin', join(dir, 'inside'))

  assert.deepEqual(await box.read('out/binary.bin'), binary)
  assert.deepEqual(await box.read('./out/large.bin'), large)
  assert.deepEqual(await box.read('inside'), binary)
  assert.deepEqual(await box.read('empty'), new Uint8Array())
  await assert.rejects(box.read('../x'), /read \.\.\/x: the path is not relative to clean-1/)
  await assert.rejects(box.read('out/../../x'), /not relative/)
  await assert.rejects(box.read('/etc/passwd'), /read \/etc\/passwd: the path is not relative to clean-1/)
  await assert.rejects(box.read('link'), /read link: the path resolves outside clean-1/)
  await assert.rejects(box.read('out/missing.bin'), /read out\/missing\.bin: no such file in clean-1/)
  await assert.rejects(box.read('out'), /read out: no such file/)
  writeFileSync(join(dir, 'huge.bin'), '')
  truncateSync(join(dir, 'huge.bin'), artifactSizeLimit + 1)
  await assert.rejects(box.read('huge.bin'), new RegExp(`read huge.bin: the file has ${artifactSizeLimit + 1} bytes, over the limit`))
})
