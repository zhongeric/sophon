import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseConfig } from '../src/cloudflare/config.ts'
import { github } from '../src/cloudflare/github.ts'
import { hasCi, parseRepoConfig, requireChecks, resolveRepoConfig } from '../src/core/checks.ts'
import { profileDefaults, type RootFiles } from '../src/core/profiles.ts'
import { loadRepoConfig } from '../src/node/platform.ts'

const root = (files: Record<string, string>): RootFiles => ({
  exists: async (name) => name in files,
  read: async (name) => files[name] ?? null,
  list: async () => Object.keys(files),
})
const manifest = (value: unknown) => JSON.stringify(value)

const foundry = {
  stack: 'Solidity+Foundry',
  checks: { build: 'forge build', format: { command: 'forge fmt --check {files}', files: '\\.sol$' } },
  tests: { pattern: '\\.t\\.sol$', command: 'forge test --match-path {test}' },
}

test('a Foundry repository gets forge checks and tests, and forge install only when it has submodules', async () => {
  assert.deepEqual(await profileDefaults(root({ 'foundry.toml': '', '.gitmodules': '' })), {
    ...foundry,
    setup: 'forge install',
    protect: ['.github/', 'foundry.toml', 'remappings.txt'],
  })
  assert.equal((await profileDefaults(root({ 'foundry.toml': '' }))).setup, undefined)
})

test('a TypeScript repository gets the commands of its package manager, its typecheck script, eslint and its test runner', async () => {
  const pnpm = { 'package.json': manifest({ scripts: { typecheck: 'tsc -b' }, devDependencies: { eslint: '9', vitest: '3' } }), 'tsconfig.json': '{}', 'pnpm-lock.yaml': '' }
  assert.deepEqual(await profileDefaults(root(pnpm)), {
    stack: 'TypeScript',
    checks: { typecheck: 'pnpm run typecheck', lint: { command: 'pnpm exec eslint {files}', files: '\\.[cm]?[jt]sx?$' } },
    tests: { pattern: '\\.(test|spec)\\.[cm]?[jt]sx?$', command: 'pnpm exec vitest run {tests}' },
    setup: 'pnpm install --frozen-lockfile',
    protect: ['.github/', 'package.json', 'tsconfig.json', 'pnpm-lock.yaml'],
  })

  const npm = await profileDefaults(root({ 'package.json': manifest({ devDependencies: { jest: '30' } }), 'tsconfig.json': '{}' }))
  assert.deepEqual(npm.checks, { typecheck: 'npx tsc --noEmit' })
  assert.deepEqual(npm.tests?.command, 'npx jest {tests}')
  assert.equal(npm.setup, 'npm install --no-package-lock --no-audit --no-fund')
  assert.deepEqual(npm.protect, ['.github/', 'package.json', 'tsconfig.json'])

  const yarn = await profileDefaults(root({ 'package.json': manifest({ scripts: { 'type-check': 'tsc' } }), 'tsconfig.json': '{}', 'yarn.lock': '', '.yarnrc.yml': '' }))
  assert.deepEqual([yarn.checks, yarn.tests, yarn.setup], [{ typecheck: 'yarn run type-check' }, undefined, 'yarn install --immutable'])

  const broken = await profileDefaults(root({ 'package.json': '{', 'tsconfig.json': '{}', 'package-lock.json': '' }))
  assert.deepEqual([broken.checks, broken.setup], [{ typecheck: 'npx tsc --noEmit' }, 'npm ci --prefer-offline --no-audit --no-fund'])
})

const venv = "python3 -m venv .venv && printf '*\\n' > .venv/.gitignore"
const pip = '.venv/bin/python -m pip install'
const eggInfo = `for d in *.egg-info src/*.egg-info; do if [ -d "$d" ]; then printf '*\\n' > "$d/.gitignore"; fi; done`
const compile = { compile: { command: `python3 -B -c "import sys; [compile(open(f, 'rb').read(), f, 'exec') for f in sys.argv[1:]]" {files}`, files: '\\.pyi?$' } }
const ruff = { ruff: { command: '.venv/bin/ruff check --no-cache --force-exclude {files}', files: '\\.pyi?$' } }
const pytest = { pattern: '(^|/)(test_[^/]*|[^/]*_test)\\.py$', command: 'PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m pytest -p no:cacheprovider {tests} || [ $? -eq 5 ]' }
const pythonProtect = ['.github/', 'pyproject.toml', 'requirements*.txt', 'uv.lock', 'poetry.lock', '.venv/']

test('a Python repository with only requirements.txt gets a venv, the install of the file, and ruff only when the file names it', async () => {
  assert.deepEqual(await profileDefaults(root({ 'requirements.txt': 'numpy==2.0\n' })), {
    stack: 'Python',
    checks: compile,
    setup: `${venv} && ${pip} -r requirements.txt`,
    protect: pythonProtect,
  })
  const tools = await profileDefaults(root({ 'requirements.txt': '# pytest\n-r base.txt\nRuff>=0.4 ; python_version >= "3.9"\n' }))
  assert.deepEqual([tools.checks, tools.tests], [ruff, undefined])
})

test('a Python project installs itself, and the dev and test extras that hold ruff or pytest', async () => {
  const buildSystem = '[build-system]\nrequires = ["setuptools"]\n'
  const main = buildSystem + '[project]\nname = "app"\ndependencies = ["ruff", "pytest>=8"]\n'
  assert.deepEqual(await profileDefaults(root({ 'pyproject.toml': main })), {
    stack: 'Python',
    checks: ruff,
    tests: pytest,
    setup: `${venv} && (${pip} -e . || ${pip} ruff 'pytest>=8') && ${eggInfo}`,
    protect: pythonProtect,
  })

  const extras = buildSystem + '[project]\nname = "app"\n[project.optional-dependencies]\ndev = ["pytest"]\ntest = ["ruff"]\ndocs = ["sphinx"]\n'
  const both = await profileDefaults(root({ 'pyproject.toml': extras, 'requirements.txt': 'numpy\n' }))
  assert.deepEqual(
    [both.checks, both.tests, both.setup],
    [ruff, pytest, `${venv} && ${pip} -r requirements.txt && (${pip} -e '.[dev,test]' || ${pip} pytest ruff) && ${eggInfo}`],
  )
})

test('a Python repository installs the other requirements files that hold ruff or pytest, and the tools of groups by name', async () => {
  const files = { 'requirements.txt': 'numpy\n', 'requirements-dev.txt': 'ruff\n', 'requirements-docs.txt': 'sphinx\n' }
  const dev = await profileDefaults(root(files))
  assert.deepEqual([dev.checks, dev.tests, dev.setup], [ruff, undefined, `${venv} && ${pip} -r requirements.txt && ${pip} -r requirements-dev.txt`])

  const groups = [
    '[dependency-groups]',
    'lint = [{ include-group = "test" }]',
    'test = ["pytest >= 8, < 9"]',
    '[tool.poetry.group.lint.dependencies]',
    'ruff = "^0.4.2"',
  ].join('\n')
  const grouped = await profileDefaults(root({ 'pyproject.toml': groups }))
  assert.deepEqual(
    [grouped.checks, grouped.tests, grouped.setup],
    [ruff, pytest, `${venv} && (${pip} -e . || :) && ${eggInfo} && ${pip} 'ruff>=0.4.2,<0.5' 'pytest>=8,<9'`],
  )

  const toolOnly = await profileDefaults(root({ 'pyproject.toml': '[dependency-groups]\ndev = ["pytest"]\n[tool.ruff]\nline-length = 100\n' }))
  assert.deepEqual([toolOnly.checks, toolOnly.tests, toolOnly.setup], [compile, pytest, `${venv} && ${pip} pytest`])
})

test('a Python repository without a project table or with a pyproject.toml that does not parse gets no project install', async () => {
  const ruffConfig = await profileDefaults(root({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' }))
  assert.deepEqual([ruffConfig.checks, ruffConfig.tests, ruffConfig.setup], [compile, undefined, venv])

  const broken = await profileDefaults(root({ 'pyproject.toml': '[project\nname = "app"\n', 'requirements.txt': 'ruff\npytest\n', 'requirements-dev.txt': 'pytest\n' }))
  assert.deepEqual([broken.checks, broken.tests, broken.setup], [compile, undefined, `${venv} && ${pip} -r requirements.txt`])
})

test('a Python and TypeScript repository joins the defaults in profile order, and keeps both lint checks', async () => {
  const both = await profileDefaults(
    root({ 'package.json': manifest({ devDependencies: { eslint: '9' } }), 'tsconfig.json': '{}', 'package-lock.json': '', 'requirements.txt': 'ruff\npytest\n' }),
  )
  assert.equal(both.stack, 'TypeScript, Python')
  assert.deepEqual(Object.keys(both.checks ?? {}), ['typecheck', 'lint', 'ruff'])
  assert.deepEqual(both.tests, pytest)
  assert.equal(both.setup, `npm ci --prefer-offline --no-audit --no-fund && ${venv} && ${pip} -r requirements.txt`)
  assert.deepEqual(both.protect, ['.github/', 'package.json', 'tsconfig.json', 'package-lock.json', 'pyproject.toml', 'requirements*.txt', 'uv.lock', 'poetry.lock', '.venv/'])
})

test('the defaults of several profiles join, and a repository with no profile gets only the protected CI paths', async () => {
  const both = await profileDefaults(root({ 'foundry.toml': '', '.gitmodules': '', 'package.json': manifest({}), 'tsconfig.json': '{}', 'package-lock.json': '' }))
  assert.equal(both.stack, 'Solidity+Foundry, TypeScript')
  assert.deepEqual(Object.keys(both.checks ?? {}), ['build', 'format', 'typecheck'])
  assert.deepEqual(both.tests, foundry.tests)
  assert.equal(both.setup, 'forge install && npm ci --prefer-offline --no-audit --no-fund')
  assert.deepEqual(both.protect, ['.github/', 'foundry.toml', 'remappings.txt', 'package.json', 'tsconfig.json', 'package-lock.json'])

  assert.deepEqual(await profileDefaults(root({ 'package.json': '{}' })), { checks: {}, protect: ['.github/'] })
})

test('each field of .agent-factory.json replaces its default, and null or an empty value turns a default off', async () => {
  const defaults = await profileDefaults(root({ 'foundry.toml': '', '.gitmodules': '' }))
  const file = parseRepoConfig(manifest({ checks: { build: 'forge build --deny-warnings' }, tests: null, setup: '', answerers: ['maintainer'] }), 'test')
  assert.deepEqual(resolveRepoConfig(defaults, file), {
    stack: 'Solidity+Foundry',
    checks: { build: 'forge build --deny-warnings' },
    tests: null,
    setup: '',
    protect: ['.github/', 'foundry.toml', 'remappings.txt'],
    answerers: ['maintainer'],
  })
  assert.deepEqual(resolveRepoConfig({ checks: {}, protect: ['.github/'] }, null), { stack: 'unknown', checks: {}, protect: ['.github/'] })
  assert.throws(() => parseRepoConfig(manifest({ checks: 'npm test' }), 'test'), /checks must be an object/)
  assert.throws(() => parseRepoConfig(manifest({ tests: { pattern: 'x', command: 'npm test' } }), 'test'), /tests.command needs \{test\} or \{tests\}/)
  assert.throws(() => requireChecks(resolveRepoConfig({}, null), 'acme/app'), /acme\/app has no checks: no profile gives default checks/)
})

test('the merge field is the standing merge permission: squash, merge or rebase, and nothing else', () => {
  for (const merge of ['squash', 'merge', 'rebase']) assert.equal(parseRepoConfig(manifest({ merge }), 'test').merge, merge)
  assert.equal('merge' in parseRepoConfig(manifest({}), 'test'), false)
  for (const merge of [null, true, 'fast-forward', 'Squash'])
    assert.throws(() => parseRepoConfig(manifest({ merge }), '.agent-factory.json'), { message: '.agent-factory.json: merge must be "squash", "merge" or "rebase"' }, String(merge))
})

test('the questions field is the standing answer of the runs: only "recommended"', () => {
  assert.equal(parseRepoConfig(manifest({ questions: 'recommended' }), 'test').questions, 'recommended')
  assert.equal('questions' in parseRepoConfig(manifest({}), 'test'), false)
  for (const questions of [null, true, 'ask', 'Recommended'])
    assert.throws(() => parseRepoConfig(manifest({ questions }), '.agent-factory.json'), { message: '.agent-factory.json: questions must be "recommended"' }, String(questions))
})

test('the ci field is an object of named commands or null, and a config without it has no ci', () => {
  const ci = { lint: 'npm run lint', build: { command: 'tsc {files}', files: '\\.ts$' } }
  assert.deepEqual(parseRepoConfig(manifest({ ci }), 'test').ci, ci)
  assert.equal(parseRepoConfig(manifest({ ci: null }), 'test').ci, null)
  for (const value of ['npm test', 3, ['npm test']])
    assert.throws(() => parseRepoConfig(manifest({ ci: value }), '.agent-factory.json'), { message: '.agent-factory.json: ci must be an object of named commands' }, String(value))
  for (const [entry, value] of [['build', null], ['build', 3], ['build', {}], ['build', { command: 3 }], ['build', { command: 'tsc {files}', files: 3 }], ['build', ['npm test']]] as const)
    assert.throws(
      () => parseRepoConfig(manifest({ ci: { lint: 'npm run lint', [entry]: value } }), '.agent-factory.json'),
      { message: `.agent-factory.json: ci.${entry} must be a command string or { command, files? } with strings` },
      JSON.stringify(value),
    )
  const resolved = resolveRepoConfig(foundry, parseRepoConfig(manifest({}), 'test'))
  assert.equal('ci' in resolved, false)
  assert.equal(hasCi(resolved), false)
  assert.equal(hasCi(resolveRepoConfig(foundry, { ci: {} })), false)
  assert.equal(hasCi(resolveRepoConfig(foundry, { ci })), true)
})

test('locally, a repository without .agent-factory.json gets the defaults of its working copy, and needs at least one check', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-config-'))
  await assert.rejects(loadRepoConfig(repo), /has no checks/)
  writeFileSync(join(repo, 'package.json'), manifest({ scripts: { typecheck: 'tsc' } }))
  writeFileSync(join(repo, 'tsconfig.json'), '{}')
  writeFileSync(join(repo, 'package-lock.json'), '{}')
  const config = await loadRepoConfig(repo)
  assert.deepEqual([config.stack, config.checks, config.setup], ['TypeScript', { typecheck: 'npm run typecheck' }, 'npm ci --prefer-offline --no-audit --no-fund'])

  const elsewhere = join(repo, 'elsewhere.json')
  writeFileSync(elsewhere, manifest({ checks: { smoke: 'true' } }))
  assert.deepEqual((await loadRepoConfig(repo, elsewhere)).checks, { smoke: 'true' })
  await assert.rejects(loadRepoConfig(repo, join(repo, 'missing.json')), /missing.json does not exist/)

  const python = mkdtempSync(join(tmpdir(), 'factory-config-'))
  writeFileSync(join(python, 'requirements.txt'), 'numpy\n')
  mkdirSync(join(python, 'requirements'))
  writeFileSync(join(python, 'requirements', 'dev.txt'), 'ruff\n')
  symlinkSync(join('requirements', 'dev.txt'), join(python, 'requirements-dev.txt'))
  symlinkSync('missing.txt', join(python, 'requirements-gone.txt'))
  symlinkSync('loop', join(python, 'loop'))
  mkdirSync(join(python, 'requirements-old.txt'))
  const listed = await loadRepoConfig(python)
  assert.deepEqual([listed.stack, Object.keys(listed.checks)], ['Python', ['ruff']])
  assert.equal(listed.setup?.endsWith('-r requirements.txt && .venv/bin/python -m pip install -r requirements-dev.txt'), true)
})

test('on Cloudflare, the config comes from one listing of the base branch root and the files that the profiles read', async () => {
  const files: Record<string, string> = { 'foundry.toml': '', '.agent-factory.json': manifest({ answerers: ['maintainer'] }) }
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    if (url.pathname === '/repos/acme/app/contents') return Response.json([...Object.keys(files).map((name) => ({ name, type: 'file' })), { name: 'src', type: 'dir' }])
    const name = decodeURIComponent(url.pathname.slice('/repos/acme/app/contents/'.length))
    return name in files ? new Response(files[name]) : Response.json({ message: 'Not Found' }, { status: 404 })
  }
  const gh = github('token', 'https://api.test', fetcher, { sleep: async () => {} })
  const config = await baseConfig(gh, 'acme', 'app', 'main')
  assert.deepEqual(config, { ...foundry, protect: ['.github/', 'foundry.toml', 'remappings.txt'], answerers: ['maintainer'], guides: {} })
  assert.deepEqual(calls, ['/repos/acme/app/contents?ref=main', '/repos/acme/app/contents/.agent-factory.json?ref=main'])

  for (const name of Object.keys(files)) delete files[name]
  Object.assign(files, { 'pyproject.toml': '[tool.ruff]\n', 'requirements-dev.txt': 'ruff\n' })
  calls.length = 0
  const python = await baseConfig(gh, 'acme', 'app', 'main')
  assert.deepEqual([python.stack, Object.keys(python.checks)], ['Python', ['ruff']])
  assert.deepEqual(calls, ['/repos/acme/app/contents?ref=main', '/repos/acme/app/contents/pyproject.toml?ref=main', '/repos/acme/app/contents/requirements-dev.txt?ref=main'])
})
