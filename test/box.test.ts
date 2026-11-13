import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { syncTree, type Box } from '../src/cloudflare/box.ts'

/** A machine whose root is a local directory, so that a test can look at what the sync wrote. */
function localBox(root: string, commands: string[]): Box {
  return {
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
