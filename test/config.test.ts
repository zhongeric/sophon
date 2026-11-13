import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseConfig } from '../src/cloudflare/config.ts'
import { github } from '../src/cloudflare/github.ts'
import { parseRepoConfig, requireChecks, resolveRepoConfig } from '../src/core/checks.ts'
import { profileDefaults, type RootFiles } from '../src/core/profiles.ts'
import { loadRepoConfig } from '../src/node/platform.ts'

const root = (files: Record<string, string>): RootFiles => ({ exists: async (name) => name in files, read: async (name) => files[name] ?? null })
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
})
