import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { callRunTests, commandChecker, isProtected, targetedTests, type RepoConfig } from '../src/core/checks.ts'
import { gitRepo } from '../src/node/git.ts'
import { localMachine, runCommand } from '../src/node/machine.ts'
import { loadRepoConfig } from '../src/node/platform.ts'
import { fixtureRepo, gitSource } from './support/fixture.ts'

test('run_tests runs only committed test files', async () => {
  const repo = fixtureRepo()
  const config = await loadRepoConfig(repo)
  const tree = gitRepo(gitSource(repo), repo, 'unused')
  const run = commandChecker(tree, config, localMachine(repo)).tests!
  writeFileSync(join(repo, 'test/new.test.ts'), "require('node:fs').writeFileSync('/tmp/ran', 'x')\n")
  await assert.rejects(callRunTests(tree, config, run, { tests: ['test/new.test.ts'] }), /not committed test files: test\/new.test.ts/)
  await assert.rejects(callRunTests(tree, config, run, { tests: ['src/math.ts'] }), /not committed test files: src\/math.ts/)
  const [result] = (await callRunTests(tree, config, run, { tests: ['/repo/test/add.test.ts'] })) as { status: string }[]
  assert.equal(result?.status, 'pass')
})

test('check commands get only the allowed environment', async () => {
  process.env.FACTORY_EXTRA = 'extra'
  process.env.FACTORY_OTHER = 'other'
  const { output } = await runCommand(tmpdir(), 'echo "$FACTORY_EXTRA|$FACTORY_OTHER|$HOME"', 10_000, ['FACTORY_EXTRA', 'HOME'])
  assert.equal(output.trim(), `extra||${process.env.HOME}`)
})

test('the checker never passes host secrets, even when the config asks for them', async () => {
  const repo = fixtureRepo()
  const seen: string[][] = []
  const checker = commandChecker(gitRepo(gitSource(repo), repo, 'unused'), { stack: 'TypeScript', checks: { smoke: 'true' }, env: ['ANTHROPIC_API_KEY', 'ETH_RPC_URL'] }, {
    async run(_command, { env }) {
      seen.push(env)
      return { exit_code: 0, output: '' }
    },
  })
  await checker.checks([])
  assert.ok(seen[0]?.includes('ETH_RPC_URL'))
  assert.ok(!seen[0]?.includes('ANTHROPIC_API_KEY'))
})

test('the setup command runs one time before the first check, and a failed setup is the only result', async () => {
  const repo = fixtureRepo()
  const commands: string[] = []
  const machine = (setupExit: number) => ({
    async run(command: string) {
      commands.push(command)
      return { exit_code: command === 'npm ci' ? setupExit : 0, output: command === 'npm ci' && setupExit ? 'no network' : '' }
    },
  })
  const config = { stack: 'TypeScript', checks: { smoke: 'true' }, setup: 'npm ci' }
  const checker = commandChecker(gitRepo(gitSource(repo), repo, 'unused'), config, machine(0))
  await checker.checks([])
  await checker.checks([])
  assert.deepEqual(commands, ['npm ci', 'true', 'true'])

  commands.length = 0
  const broken = commandChecker(gitRepo(gitSource(repo), repo, 'unused'), config, machine(1))
  assert.deepEqual((await broken.checks([])).map(({ name, status, output }) => [name, status, output]), [['setup', 'fail', 'no network']])
  await broken.checks([])
  assert.deepEqual(commands, ['npm ci', 'npm ci'])
})

/** A committed tree in memory. Paths in `removed` are committed but not in the tree. */
function memoryTree(files: Record<string, string>, removed: string[] = []) {
  return {
    tree: MemoryFileSystem.create({ files: Object.fromEntries(Object.entries(files).map(([path, content]) => [`/${path}`, content])) }),
    committedFiles: async () => [...Object.keys(files), ...removed],
  }
}

const tsConfig: RepoConfig = { stack: 'TypeScript', checks: {}, tests: { pattern: '^test/[^/]+\\.test\\.ts$', command: 'node --test {tests}' } }

test('a change to src/core/agent.ts selects test/agent.test.ts and not test/cloudflare.test.ts', async () => {
  const repo = memoryTree({
    'src/core/agent.ts': 'export {}\n',
    'test/agent.test.ts': readFileSync(new URL('./agent.test.ts', import.meta.url), 'utf8'),
    'test/cloudflare.test.ts': readFileSync(new URL('./cloudflare.test.ts', import.meta.url), 'utf8'),
  })
  assert.deepEqual(await targetedTests(repo, tsConfig, ['src/core/agent.ts']), ['test/agent.test.ts'])
})

test('a changed file that no test imports falls back to the word match', async () => {
  const repo = memoryTree({
    'src/cloudflare/runs.ts': 'export {}\n',
    'README.md': '# readme\n',
    'test/worker.test.ts': "import { startWorker } from './support/wrangler.ts'\n// wrangler dev runs src/cloudflare/runs.ts\n",
    'test/docs.test.ts': "const text = readFileSync('README.md', 'utf8')\n",
    'test/other.test.ts': "import { add } from '../src/math.ts'\n",
  })
  assert.deepEqual(await targetedTests(repo, tsConfig, ['src/cloudflare/runs.ts']), ['test/worker.test.ts'])
  assert.deepEqual(await targetedTests(repo, tsConfig, ['README.md']), ['test/docs.test.ts'])
})

test('TypeScript import, export and require lines select the tests of the changed file', async () => {
  const repo = memoryTree({
    'src/math.ts': 'export {}\n',
    'test/multi.test.ts': "import {\n  add,\n  sub,\n} from '../src/math.ts'\n",
    'test/reexport.test.ts': "export { add } from '../src/math.ts'\n",
    'test/required.test.ts': "const math = require('../src/math')\n",
    'test/side.test.ts': "import '../src/math.ts'\n",
    'test/words.test.ts': "// the math of this test is simple\nimport { other } from '../src/other.ts'\n",
  })
  assert.deepEqual(await targetedTests(repo, tsConfig, ['src/math.ts']), [
    'test/multi.test.ts',
    'test/reexport.test.ts',
    'test/required.test.ts',
    'test/side.test.ts',
  ])
})

test('Solidity import lines select the tests of the changed contract', async () => {
  const config: RepoConfig = { stack: 'Solidity', checks: {}, tests: { pattern: '\\.t\\.sol$', command: 'forge test --match-path {test}' } }
  const repo = memoryTree({
    'src/Vault.sol': 'contract Vault {}\n',
    'test/Vault.t.sol': 'import {Vault} from "../src/Vault.sol";\n',
    'test/Raw.t.sol': 'import "../src/Vault.sol";\n',
    'test/Token.t.sol': 'import {Token} from "../src/Token.sol";\n// the Vault is not under test\n',
  })
  assert.deepEqual(await targetedTests(repo, config, ['src/Vault.sol']), ['test/Vault.t.sol', 'test/Raw.t.sol'])
})

test('Python import lines select the tests of the changed module', async () => {
  const config: RepoConfig = { stack: 'Python', checks: {}, tests: { pattern: '(^|/)test_[^/]*\\.py$', command: 'pytest {tests}' } }
  const repo = memoryTree({
    'search/known.py': 'KNOWN = 1\n',
    'tests/test_import.py': 'import search.known\n',
    'tests/test_from.py': 'from search import known\n',
    'tests/test_list.py': 'import os, search.known as sk\n',
    'tests/test_parens.py': 'from search import (\n    other,\n    known as k,\n)\n',
    'tests/test_relative.py': 'from ..search.known import Thing\n',
    'tests/test_words.py': '# known words only\nimport os\n',
  })
  assert.deepEqual(await targetedTests(repo, config, ['search/known.py']), [
    'tests/test_import.py',
    'tests/test_from.py',
    'tests/test_list.py',
    'tests/test_parens.py',
    'tests/test_relative.py',
  ])
})

test('changed test files are targeted, removed test files are not, and two sources with one base name select the tests of both', async () => {
  const repo = memoryTree(
    {
      'src/a/util.ts': 'export {}\n',
      'src/b/util.ts': 'export {}\n',
      'test/a.test.ts': "import { a } from '../src/a/util.ts'\n",
      'test/b.test.ts': "import { b } from '../src/b/util.ts'\n",
      'test/c.test.ts': "import { c } from '../src/c.ts'\n",
    },
    ['test/gone.test.ts'],
  )
  assert.deepEqual(await targetedTests(repo, tsConfig, ['src/a/util.ts', 'test/c.test.ts', 'test/gone.test.ts']), ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'])
})

test('checks with tests off run no test command, and checks by default run the targeted tests', async () => {
  const repo = memoryTree({ 'src/math.ts': 'export {}\n', 'test/math.test.ts': "import { add } from '../src/math.ts'\n" })
  const commands: string[] = []
  const config = { ...tsConfig, checks: { typecheck: 'npm run check' }, setup: 'npm ci' }
  const checker = commandChecker(repo, config, {
    async run(command) {
      commands.push(command)
      return { exit_code: 0, output: '' }
    },
  })
  assert.deepEqual((await checker.checks(['src/math.ts'], { tests: false })).map(({ name }) => name), ['typecheck'])
  assert.deepEqual(commands, ['npm ci', 'npm run check'])
  commands.length = 0
  assert.deepEqual((await checker.checks(['src/math.ts'])).map(({ name }) => name), ['typecheck', 'tests'])
  assert.deepEqual(commands, ['npm run check', "node --test 'test/math.test.ts'"])
})

test('the config file and its protect entries are protected', () => {
  const config = { stack: 'TypeScript', checks: { smoke: 'true' }, protect: ['ci/', 'package.json'] }
  assert.equal(isProtected(config, '/.agent-factory.json'), true)
  assert.equal(isProtected(config, '/ci/check.sh'), true)
  assert.equal(isProtected(config, '/package.json'), true)
  assert.equal(isProtected(config, '/src/package.json'), false)
})

test('a star in a protect entry matches characters in one path segment', () => {
  const config = { stack: 'Python', checks: { smoke: 'true' }, protect: ['requirements*.txt', 'pkg*/', 'a.b(c)+*'] }
  assert.equal(isProtected(config, '/.agent-factory.json'), true)
  assert.equal(isProtected(config, '/requirements.txt'), true)
  assert.equal(isProtected(config, '/requirements-dev.txt'), true)
  assert.equal(isProtected(config, '/sub/requirements.txt'), false)
  assert.equal(isProtected(config, '/requirements/dev.txt'), false)
  assert.equal(isProtected(config, '/requirementsXtxt'), false)
  assert.equal(isProtected(config, '/pkg-a/x.py'), true)
  assert.equal(isProtected(config, '/pkg/sub/x.py'), true)
  assert.equal(isProtected(config, '/pkg-a'), false)
  assert.equal(isProtected(config, '/src/pkg-a/x.py'), false)
  assert.equal(isProtected(config, '/a.b(c)+d'), true)
  assert.equal(isProtected(config, '/aXb(c)+d'), false)
  const all = { stack: 'Python', checks: { smoke: 'true' }, protect: ['*'] }
  assert.equal(isProtected(all, '/setup.py'), true)
  assert.equal(isProtected(all, '/src/setup.py'), true)
  const dirs = { stack: 'Python', checks: { smoke: 'true' }, protect: ['deploy*', 'config/*', 'pkg*'] }
  assert.equal(isProtected(dirs, '/deploy-prod'), true)
  assert.equal(isProtected(dirs, '/deploy-prod/run.sh'), true)
  assert.equal(isProtected(dirs, '/config/prod/keys.json'), true)
  assert.equal(isProtected(dirs, '/config'), false)
  assert.equal(isProtected(dirs, '/pkg-a/x.py'), true)
  assert.equal(isProtected(dirs, '/src/pkg-a/x.py'), false)
})
