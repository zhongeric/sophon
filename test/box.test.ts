import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { boxMachine, containerBox, syncTree, syncWithSetup, type Box } from '../src/cloudflare/box.ts'

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
  const synced = new Map<string, Map<string, string>>()
  const box = containerBox(container, { inactivityMs: 60_000, onStart: () => synced.clear() })
  const tree = MemoryFileSystem.create({ files: { '/a.txt': 'a' } })
  const setup = { command: 'echo installed > setup.txt', timeoutMs: 60_000 }
  const machine = boxMachine(box, 'work/x', () => syncWithSetup(box, synced, tree, 'work/x', setup))
  const check = () => machine.run('cat a.txt setup.txt', { env: [], timeoutMs: 60_000 })

  assert.deepEqual(await check(), { exit_code: 0, output: 'ainstalled\n' })
  // The container stops after inactivity, while the object still knows what the directory held.
  container.running = false
  assert.deepEqual(await check(), { exit_code: 0, output: 'ainstalled\n' })
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
