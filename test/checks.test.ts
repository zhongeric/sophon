import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { callRunTests, commandChecker, isProtected } from '../src/core/checks.ts'
import { gitRepo } from '../src/node/git.ts'
import { localMachine, runCommand } from '../src/node/machine.ts'
import { loadRepoConfig } from '../src/node/platform.ts'
import { fixtureRepo, gitSource } from './support/fixture.ts'

test('run_tests runs only committed test files', async () => {
  const repo = fixtureRepo()
  const config = loadRepoConfig(join(repo, '.agent-factory.json'))
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

test('the config file and its protect entries are protected', () => {
  const config = { stack: 'TypeScript', checks: { smoke: 'true' }, protect: ['ci/', 'package.json'] }
  assert.equal(isProtected(config, '/.agent-factory.json'), true)
  assert.equal(isProtected(config, '/ci/check.sh'), true)
  assert.equal(isProtected(config, '/package.json'), true)
  assert.equal(isProtected(config, '/src/package.json'), false)
})
