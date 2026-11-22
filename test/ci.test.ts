import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureExcerpt } from '../src/core/ci.ts'

const budget = 6_000
const passes = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `ok ${from + index} - a test passes\n`).join('')
const failure = 'not ok 793 - the runs keep their invariants\n  ---\n  seed: 4242\n  reason: the ledger lost a job\n  ...\n'
const summary = '# tests 800\n# pass 799\n# fail 1\n'
const endMark = '[... end of the log]\n'
/** The part of an excerpt before the end of the log. */
const head = (excerpt: string) => excerpt.split(endMark)[0]
/** A block holds its marker line and the next lines, 40 lines in total, when no other marker line comes first. */
const firstLines = (text: string) => `${text.split('\n').slice(0, 40).join('\n')}\n`

test('a long log keeps a not ok block far from its end, and the end', () => {
  const log = `${passes(100)}${failure}${passes(400, 794)}${summary}`
  assert.ok(log.indexOf(failure) < log.length - budget)
  const excerpt = failureExcerpt(log, budget)
  const block = firstLines(log.slice(log.indexOf(failure)))
  assert.ok(block.startsWith(failure))
  assert.equal(excerpt, `${block}${endMark}${log.slice(-(budget - block.length - endMark.length))}`)
})

test('a log that fits in the budget stays whole', () => {
  const log = `${failure}${passes(10)}${summary}`
  assert.equal(failureExcerpt(log, budget), log)
})

test('a block stops after 40 lines and before the next marker line', () => {
  const details = Array.from({ length: 60 }, (_, index) => `detail ${index + 1}\n`).join('')
  const long = failureExcerpt(`Error: boom\n${details}${passes(500)}`, budget)
  assert.equal(head(long), `Error: boom\n${details.split('detail 40\n')[0]}`)
  const second = `FAIL test/b.test.ts\nsecond reason\n${passes(500)}`
  const next = failureExcerpt(`FAIL test/a.test.ts\nfirst reason\n${second}`, budget)
  assert.equal(head(next), `FAIL test/a.test.ts\nfirst reason\n${firstLines(second)}`)
})

test('a marker after a timestamp or a job and step prefix starts a block, and lower-case fail does not', () => {
  const actions = '2026-11-22T05:10:54.1234567Z ##[error]Process completed with exit code 1.\n'
  const gh = 'test\tRun npm test\t2026-11-22T05:10:50.0000000Z not ok 793 - the runs keep their invariants\n'
  const first = `${gh}${passes(300)}`
  const second = `${actions}${passes(300, 301)}`
  assert.equal(head(failureExcerpt(`${first}${second}`, budget)), `${firstLines(first)}${firstLines(second)}`)
  const lower = `# fail 1\nthe test failed\n${passes(500)}`
  assert.equal(failureExcerpt(lower, budget), lower.slice(-budget))
})

test('a block inside the kept end is not repeated', () => {
  const late = 'Error: late\n'
  const only = `${passes(500)}${late}${passes(10, 501)}`
  assert.equal(failureExcerpt(only, budget), only.slice(-budget))
  const early = `${failure}${passes(500, 101)}`
  const both = failureExcerpt(`${passes(100)}${early}${late}${passes(10, 601)}`, budget)
  assert.equal(head(both), firstLines(early))
  assert.equal(both.split(late).length, 2)
})

test('blocks that do not fit give the first blocks and the count of the cut blocks', () => {
  const blocks = Array.from({ length: 100 }, (_, index) => `FAIL test/case-${index}.test.ts\n  expected 1 to equal 2 in case ${index}\n`)
  const log = `${blocks.join('')}${passes(500)}${summary}`
  const excerpt = failureExcerpt(log, budget)
  const kept = blocks.filter((block) => excerpt.includes(block)).length
  assert.ok(kept > 0 && kept < blocks.length)
  const note = `[${blocks.length - kept} more failure blocks cut]\n`
  assert.equal(head(excerpt), `${blocks.slice(0, kept).join('')}${note}`)
  assert.ok(excerpt.endsWith(summary))
  assert.ok(excerpt.length <= budget + note.length)
})

test('a first block longer than the block space keeps its first whole lines, and only the later blocks count as cut', () => {
  const prefix = 'test\tRun npm test\t2026-11-22T05:10:50.0000000Z '
  const line = (text: string) => `${prefix}${text}`.padEnd(120, '.') + '\n'
  const first = [line('not ok 793 - the runs keep their invariants'), ...Array.from({ length: 39 }, (_, index) => line(`    at frame ${index} (file:///repo/src/core/develop.ts)`))].join('')
  assert.ok(first.length > budget - 2_000)
  const later = ['FAIL test/a.test.ts\n', 'FAIL test/b.test.ts\n']
  const log = `${first}${later.join('')}${passes(500)}${summary}`
  const excerpt = failureExcerpt(log, budget)
  const note = '[2 more failure blocks cut]\n'
  assert.ok(excerpt.startsWith(line('not ok 793 - the runs keep their invariants')))
  const kept = head(excerpt) ?? ''
  assert.ok(kept.endsWith(note))
  const lines = kept.slice(0, -note.length)
  assert.ok(lines.endsWith('\n') && first.startsWith(lines))
  assert.ok(excerpt.endsWith(summary))
  assert.ok(excerpt.length <= budget + note.length)
})

test('the end of the log keeps 2,000 characters when the blocks fill the block space', () => {
  const block = `Error: ${'x'.repeat(182)}\n${`${'d'.repeat(99)}\n`.repeat(38)}`
  assert.equal(block.length, 3_990)
  const excerpt = failureExcerpt(`${block}FAIL test/a.test.ts\n${passes(500)}${summary}`, budget)
  assert.ok((excerpt.split(endMark)[1] ?? '').length >= 2_000)
  assert.ok(excerpt.endsWith(summary))
})
