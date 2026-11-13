import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Finding, Severity } from '../src/core/findings.ts'
import { bugsShards, diffFiles, diffOf, fileOwners, maxBugsShards, maxPatchGroups, patchGroups } from '../src/core/split.ts'

/** A diff that adds `lines` lines to each file. */
const diffOfSizes = (sizes: Record<string, number>) =>
  Object.entries(sizes)
    .map(([path, lines]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${'+line\n'.repeat(lines)}`)
    .join('')

test('diffFiles counts the added and removed lines of each file, and diffOf keeps the sections of some files', () => {
  const diff = `${diffOfSizes({ 'src/a.ts': 3 })}diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,1 @@\n-old\n-older\n+new\n context\n`
  assert.deepEqual(
    diffFiles(diff).map(({ path, lines }) => [path, lines]),
    [
      ['src/a.ts', 3],
      ['src/b.ts', 3],
    ],
  )
  assert.equal(diffOf(diff, ['src/b.ts']), diffFiles(diff)[1]!.section)
  assert.equal(diffOf(diff, []), '')
})

test('a small diff gets one bugs reviewer', () => {
  assert.deepEqual(bugsShards(diffOfSizes({ 'src/a.ts': 300, 'test/a.test.ts': 200 })), [['src/a.ts', 'test/a.test.ts']])
  assert.deepEqual(bugsShards(''), [[]])
})

test('a large diff splits across bugs reviewers by directory, and a directory larger than a share splits by file', () => {
  const diff = diffOfSizes({ 'src/alpha/a.ts': 500, 'src/alpha/b.ts': 200, 'src/beta/c.ts': 400, 'test/x.test.ts': 300 })
  assert.deepEqual(bugsShards(diff), [['src/alpha/a.ts'], ['src/beta/c.ts'], ['src/alpha/b.ts', 'test/x.test.ts']])

  const two = diffOfSizes({ 'src/core/a.ts': 300, 'src/core/b.ts': 300, 'src/node/c.ts': 300, 'src/node/d.ts': 300 })
  assert.deepEqual(bugsShards(two), [['src/core/a.ts', 'src/core/b.ts'], ['src/node/c.ts', 'src/node/d.ts']])
})

test('the count of bugs reviewers has a limit, and each file goes to exactly one reviewer', () => {
  const sizes = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`dir${index}/file.ts`, 500]))
  const shards = bugsShards(diffOfSizes(sizes))
  assert.equal(shards.length, maxBugsShards)
  assert.deepEqual(shards.flat().sort(), Object.keys(sizes).sort())
})

const finding = (id: string, location: string, severity: Severity): Finding => ({
  id,
  track: 'bugs',
  location,
  severity,
  title: id,
  trigger: 't',
  impact: 'i',
  evidence: 'e',
  recommendation: 'r',
})
const ids = (groups: ReturnType<typeof patchGroups>) => groups.map((group) => group.findings.map((item) => item.id))

test('patch groups follow the files of the findings, and info findings join the owner of their file or one group of their own', () => {
  const kept = [
    finding('bugs-001', 'src/a.ts:3', 'high'),
    finding('bugs-002', 'src/b.ts:9', 'medium'),
    finding('min-001', 'src/a.ts:20-24', 'low'),
    finding('anti-001', 'src/c.ts:1', 'info'),
    finding('anti-002', 'src/a.ts:7', 'info'),
    finding('anti-003', 'README.md:2', 'info'),
  ]
  const groups = patchGroups(kept)
  assert.deepEqual(ids(groups), [['bugs-001', 'min-001', 'anti-002'], ['bugs-002'], ['anti-001', 'anti-003']])
  assert.deepEqual(groups.map((group) => group.files), [['src/a.ts'], ['src/b.ts'], ['src/c.ts', 'README.md']])
  assert.deepEqual(ids(patchGroups(kept.slice(0, 1))), [['bugs-001']])
  assert.deepEqual(ids(patchGroups(kept.filter((item) => item.severity === 'info'))), [['anti-001', 'anti-002', 'anti-003']])
})

test('above the limit, the smallest patch groups merge, and the info group stays on its own', () => {
  const kept = [
    ...Array.from({ length: 6 }, (_, index) => finding(`bugs-00${index + 1}`, `src/f${index}.ts:1`, 'medium')),
    finding('bugs-007', 'src/f0.ts:9', 'medium'),
    finding('anti-001', 'docs/a.md:1', 'info'),
  ]
  const groups = patchGroups(kept)
  assert.equal(groups.length, maxPatchGroups)
  assert.deepEqual(ids(groups).at(-1), ['anti-001'])
  assert.deepEqual(ids(groups).flat().sort(), kept.map((item) => item.id).sort())
  const files = groups.flatMap((group) => group.files)
  assert.equal(new Set(files).size, files.length)
  for (const group of groups) assert.deepEqual(group.findings, [...group.findings].sort((a, b) => kept.indexOf(a) - kept.indexOf(b)))
})

test('each patch agent writes its own files, and the first agent that writes a file of no group owns it', () => {
  const groups = [
    { findings: [], files: ['src/a.ts'] },
    { findings: [], files: ['src/b.ts'] },
  ]
  const saved: Record<string, number>[] = []
  const owners = fileOwners(groups, {}, (claims) => saved.push({ ...claims }))
  assert.equal(owners(0)('src/a.ts'), true)
  assert.equal(owners(1)('src/a.ts'), false)
  assert.equal(owners(1)('test/shared.test.ts'), true)
  assert.equal(owners(0)('test/shared.test.ts'), false)
  assert.equal(owners(1)('test/shared.test.ts'), true)
  assert.deepEqual(saved, [{ 'test/shared.test.ts': 1 }])

  const resumed = fileOwners(groups, { ...saved.at(-1) }, () => {})
  assert.equal(resumed(0)('test/shared.test.ts'), false)
})
