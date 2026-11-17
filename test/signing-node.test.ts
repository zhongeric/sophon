import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SigningRecord } from '../src/core/signing.ts'
import { StopError } from '../src/core/stop.ts'
import type { Gh } from '../src/node/channels.ts'
import { gitBranches, gitRepo, worktreePath, type GitCommits } from '../src/node/git.ts'
import { githubRepository, nodeSigning } from '../src/node/signing.ts'

/** A repository that signs each commit, with a gpg.program that always fails: there is no usable key. */
function signingRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'factory-signing-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'true')
  run('config', 'gpg.program', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  run('add', '-A')
  run('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base')
  return repo
}

const revParse = (repo: string, ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim()
const refs = (repo: string) => execFileSync('git', ['for-each-ref'], { cwd: repo, encoding: 'utf8' })

/** A gh that fails the test when the code calls it. */
const noGh: Gh = async (args) => assert.fail(`unexpected gh call: ${args.join(' ')}`)

/** A gh that answers `gh api <path>` from a script. A path without an answer fails as gh does for a 404. */
function scriptedGh(answers: Record<string, unknown>) {
  const calls: string[] = []
  const run: Gh = async (args) => {
    const path = args[1] ?? ''
    calls.push(args.join(' '))
    const answer = answers[path]
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw new Error(`gh api ${path}: gh: Not Found (HTTP 404)`)
    return JSON.stringify(answer)
  }
  return { run, calls }
}

const signed: SigningRecord = { origin: true, branches: [{ branch: 'main', rulesets: ['Protect main'], classic: 'none' }], mode: 'signed' }

test('unsigned mode commits and merges with commit.gpgsign on and no key', async () => {
  const repo = signingRepo()
  const base = revParse(repo, 'HEAD')
  const commits: GitCommits = { unsigned: false }
  const tree = gitRepo({ repo, base: 'main', head: 'main' }, repo, 'unused', commits)
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await assert.rejects(tree.commit('signed'))
  // The adapters read the mode at each commit, so the change after construction counts.
  commits.unsigned = true
  await tree.commit('unsigned')
  assert.notEqual(revParse(repo, 'HEAD'), base)

  const dir = mkdtempSync(join(tmpdir(), 'factory-signing-branches-'))
  const branches = gitBranches(repo, dir, commits)
  const left = await branches.branch('factory/left', base)
  const right = await branches.branch('factory/right', base)
  writeFileSync(join(worktreePath(dir, left.name), 'left.txt'), 'left\n')
  await left.commit('left')
  writeFileSync(join(worktreePath(dir, right.name), 'right.txt'), 'right\n')
  await right.commit('right')
  await left.merge('factory/right', 'merge right')
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'factory/left'], { cwd: repo, encoding: 'utf8' }).trim().split(' ')
  assert.equal(parents.length, 3)
})

test('check without a GitHub origin gives unsigned commits and calls no gh', async () => {
  const repo = signingRepo()
  const signing = nodeSigning(repo, { unsigned: false }, noGh)
  assert.deepEqual(await signing.check(['main']), { origin: false, branches: [], mode: 'unsigned' })
  execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/o/r.git'], { cwd: repo })
  assert.deepEqual(await signing.check(['main']), { origin: false, branches: [], mode: 'unsigned' })
})

test('check with a GitHub origin and no branch calls no gh', async () => {
  const repo = signingRepo()
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: repo })
  assert.deepEqual(await nodeSigning(repo, { unsigned: false }, noGh).check([]), { origin: true, branches: [], mode: 'unsigned' })
})

test('only a github.com URL names a GitHub repository', () => {
  for (const url of ['https://github.com/o/r', 'https://github.com/o/r.git', 'ssh://git@github.com/o/r.git', 'git@github.com:o/r', 'git@github.com:o/r.git\n']) {
    assert.deepEqual(githubRepository(url), { owner: 'o', repo: 'r' }, url)
  }
  for (const url of ['https://github.example.com/o/r', 'git@gitlab.com:o/r.git', '/tmp/origin.git', 'https://notgithub.com/o/r']) assert.equal(githubRepository(url), null, url)
})

test('check reads the rules of the branch through gh api', async () => {
  const repo = signingRepo()
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo })
  const none = scriptedGh({ 'repos/o/r/rules/branches/factory%2Fdev-x?per_page=100&page=1': [] })
  assert.deepEqual(await nodeSigning(repo, { unsigned: false }, none.run).check(['factory/dev-x']), {
    origin: true,
    branches: [{ branch: 'factory/dev-x', rulesets: [], classic: 'none' }],
    mode: 'unsigned',
  })
  assert.deepEqual(none.calls, ['api repos/o/r/rules/branches/factory%2Fdev-x?per_page=100&page=1', 'api repos/o/r/branches/factory%2Fdev-x/protection/required_signatures'])

  const rule = scriptedGh({
    'repos/o/r/rules/branches/main?per_page=100&page=1': [{ type: 'required_signatures', ruleset_id: 7 }],
    'repos/o/r/rulesets/7': { id: 7, name: 'Protect main' },
  })
  assert.deepEqual(await nodeSigning(repo, { unsigned: false }, rule.run).check(['main']), signed)

  // A 5xx and a call without an answer can go away, so they are not a StopError.
  const broken = scriptedGh({ 'repos/o/r/rules/branches/main?per_page=100&page=1': new Error('gh api repos/o/r/rules/branches/main: gh: Server Error (HTTP 500)') })
  await assert.rejects(nodeSigning(repo, { unsigned: false }, broken.run).check(['main']), (error) => error instanceof Error && !(error instanceof StopError) && /500/.test(error.message))

  const offline = scriptedGh({ 'repos/o/r/rules/branches/main?per_page=100&page=1': new Error('gh api repos/o/r/rules/branches/main: error connecting to api.github.com') })
  await assert.rejects(nodeSigning(repo, { unsigned: false }, offline.run).check(['main']), (error) => error instanceof Error && !(error instanceof StopError) && /error connecting/.test(error.message))
})

test('apply of a signed record stops when git cannot sign', async () => {
  const repo = signingRepo()
  const commits: GitCommits = { unsigned: true }
  const before = refs(repo)
  await assert.rejects(
    nodeSigning(repo, commits, noGh).apply(signed),
    (error) => error instanceof StopError && error.message.includes('Protect main') && error.message.includes('user.signingkey'),
  )
  assert.equal(commits.unsigned, false)
  assert.equal(refs(repo), before)
})

test('apply of a signed record stops when a rule requires signatures and commit.gpgsign is off', async () => {
  const repo = signingRepo()
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  await assert.rejects(
    nodeSigning(repo, { unsigned: true }, noGh).apply(signed),
    (error) => error instanceof StopError && error.message.includes('Protect main') && error.message.includes('commit.gpgsign'),
  )
})

test('apply of a signed record with only an unreadable classic protection continues when commit.gpgsign is off', async () => {
  const repo = signingRepo()
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  const commits: GitCommits = { unsigned: true }
  await nodeSigning(repo, commits, noGh).apply({ origin: true, branches: [{ branch: 'main', rulesets: [], classic: 'unreadable' }], mode: 'signed' })
  assert.equal(commits.unsigned, false)
})

test('apply of an unsigned record sets unsigned commits', async () => {
  const repo = signingRepo()
  const commits: GitCommits = { unsigned: false }
  await nodeSigning(repo, commits, noGh).apply({ origin: false, branches: [], mode: 'unsigned' })
  assert.equal(commits.unsigned, true)
})
