import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { checkPrereg, coreSections, freezePrereg, isPreregPath, type Prereg } from '../src/core/prereg.ts'

const options = { picked: ['hyp-001', 'hyp-003'], domainSections: ['Holdout'] }
const sections = [...coreSections, 'Holdout'].map((name) => ({ name, text: `The ${name.toLowerCase()} of the search.` }))
const valid = { hypothesis: 'hyp-001', sections, known_recall: 0.9 }
const without = (name: string) => sections.filter((section) => section.name !== name)

test('a valid prereg passes and comes back typed', () => {
  assert.deepEqual(checkPrereg(valid, options), valid)
})

test('each core section and each domain section is required', () => {
  for (const name of [...coreSections, 'Holdout'])
    assert.throws(() => checkPrereg({ ...valid, sections: without(name) }, options), new RegExp(`^Error: the prereg needs the section "${name}" with text$`), name)
})

test('a domain section that is also a core section is required one time', () => {
  assert.deepEqual(checkPrereg(valid, { ...options, domainSections: ['known set', 'Holdout'] }), valid)
  assert.throws(() => checkPrereg({ ...valid, sections: without('Known set') }, { ...options, domainSections: [' known SET '] }), /^Error: the prereg needs the section "Known set" with text$/)
})

test('section names match without case and trimmed, and extra sections are permitted', () => {
  const renamed = sections.map((section) => ({ ...section, name: `  ${section.name.toUpperCase()} ` }))
  assert.equal(checkPrereg({ ...valid, sections: renamed }, options).sections.length, sections.length)
  const extra = [...sections, { name: 'Notes', text: 'More.' }]
  assert.deepEqual(checkPrereg({ ...valid, sections: extra }, options).sections, extra)
})

test('a repeated section name is refused', () => {
  assert.throws(() => checkPrereg({ ...valid, sections: [...sections, { name: ' method', text: 'Again.' }] }, options), /^Error: sections\[7\]: the section "method" repeats$/)
})

test('a section with empty or whitespace text counts as missing', () => {
  for (const text of ['', ' \n\t'])
    assert.throws(() => checkPrereg({ ...valid, sections: sections.map((section) => (section.name === 'Data' ? { ...section, text } : section)) }, options), /^Error: the prereg needs the section "Data" with text$/)
})

test('known_recall is a finite number from 0 to 1', () => {
  for (const known_recall of [0, 1, 0.5]) assert.equal(checkPrereg({ ...valid, known_recall }, options).known_recall, known_recall)
  for (const known_recall of [-0.1, 1.01, '0.9', null, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => checkPrereg({ ...valid, known_recall }, options), /^Error: known_recall must be a number from 0 to 1$/, String(known_recall))
})

test('the hypothesis must be one of the picked IDs', () => {
  assert.equal(checkPrereg({ ...valid, hypothesis: 'hyp-003' }, options).hypothesis, 'hyp-003')
  assert.throws(() => checkPrereg({ ...valid, hypothesis: 'hyp-002' }, options), /^Error: hypothesis must be one of the picked IDs: hyp-001, hyp-003$/)
})

test('one rejection lists all problems', () => {
  const bad = { hypothesis: 'hyp-009', sections: [...without('Method'), { name: 'data', text: 'Again.' }], known_recall: 2 }
  assert.throws(
    () => checkPrereg(bad, options),
    (error: Error) => {
      assert.deepEqual(error.message.split('\n'), [
        'hypothesis must be one of the picked IDs: hyp-001, hyp-003',
        'sections[6]: the section "data" repeats',
        'the prereg needs the section "Method" with text',
        'known_recall must be a number from 0 to 1',
      ])
      return true
    },
  )
  assert.throws(() => checkPrereg(undefined, options), /hypothesis must be .*\nsections must be a list\nthe prereg needs the section "Hypothesis"/s)
})

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

test('the freeze gives v1 at the versioned path with a stable Markdown and its SHA-256', async () => {
  const prereg: Prereg = checkPrereg({ ...valid, sections: [{ name: 'Notes', text: 'Ünïcode.' }, ...sections] }, options)
  const frozen = await freezePrereg(prereg)
  assert.equal(frozen.version, 1)
  assert.equal(frozen.path, 'prereg/hyp-001-v1.md')
  assert.equal(frozen.hypothesis, 'hyp-001')
  assert.equal(frozen.sha256, sha256(frozen.markdown))
  assert.deepEqual(await freezePrereg(structuredClone(prereg)), frozen)
  assert.match(frozen.markdown, /^# Prereg hyp-001 v1\n\nKnown recall: 0\.9\n\n## Notes\n\nÜnïcode\.\n\n## Hypothesis\n/)
  const headings = frozen.markdown.split('\n').filter((line) => line.startsWith('## '))
  assert.deepEqual(headings, prereg.sections.map((section) => `## ${section.name}`))
  assert.doesNotMatch(frozen.markdown, /Amendment/)
})

test('an amendment gives the next version with its reason and a new hash', async () => {
  const first = await freezePrereg(checkPrereg(valid, options))
  const second = await freezePrereg(checkPrereg({ ...valid, known_recall: 0.8 }, options), { previous: first, reason: 'The known set has two more objects.' })
  assert.equal(second.version, 2)
  assert.equal(second.path, 'prereg/hyp-001-v2.md')
  assert.match(second.markdown, /^# Prereg hyp-001 v2\n/)
  assert.match(second.markdown, new RegExp(`## Amendment\n\nAmends v1 \\(SHA-256 ${first.sha256}\\)\\.\n\nThe known set has two more objects\\.\n`))
  assert.equal(second.sha256, sha256(second.markdown))
  assert.notEqual(second.sha256, first.sha256)
  const third = await freezePrereg(checkPrereg(valid, options), { previous: second, reason: 'Back to 0.9.' })
  assert.equal(third.path, 'prereg/hyp-001-v3.md')
})

test('an amendment needs the earlier version, a reason and the same hypothesis', async () => {
  const prereg = checkPrereg(valid, options)
  const first = await freezePrereg(prereg)
  await assert.rejects(freezePrereg(prereg, { reason: 'More data.' }), /^Error: an amendment needs the earlier frozen version$/)
  for (const reason of [undefined, '', '  ']) await assert.rejects(freezePrereg(prereg, { previous: first, reason }), /^Error: an amendment needs a reason$/)
  await assert.rejects(freezePrereg({ ...prereg, hypothesis: 'hyp-003' }, { previous: first, reason: 'Other.' }), /^Error: an amendment must be for hyp-001, not hyp-003$/)
})

test('the path helper finds paths under prereg/', () => {
  for (const path of ['prereg/x', './prereg/x', '/repo/prereg/x', '/prereg/x', 'prereg', 'prereg/a/../b.md', 'prereg//hyp-001-v1.md'])
    assert.equal(isPreregPath(path), true, path)
  for (const path of ['prereg-old/x', 'prereg/../x', './prereg/../../prereg/x', '../prereg/x', 'src/prereg/x', 'repo/prereg/x', '/repo/src/x', '', '.'])
    assert.equal(isPreregPath(path), false, path)
})
