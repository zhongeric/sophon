import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRepoConfig } from '../src/core/checks.ts'
import { loadResearchDomain, parseResearchConfig, type ResearchConfig, type ResearchFiles } from '../src/core/research.ts'
import { StopError } from '../src/core/stop.ts'

const source = '.agent-factory.json on main'

/** The example of section 6.3 of docs/specs/research-workflow.md. */
const example = {
  egress: ['archive.example.org', 'export.arxiv.org'],
  holdout: 'research/holdout.json',
  lenses: { survey: ['literature', 'known objects', 'data coverage'], skeptic: ['systematics', 'contamination', 'known', 'statistics'] },
  guides: 'research/guides',
  checklist: 'research/checklist.md',
  prereg_sections: ['Known set', 'Injection grid', 'Holdout'],
  commands: {
    known: 'python -m search.known {prereg}',
    inject: 'python -m search.inject {prereg}',
    sweep: 'python -m search.sweep {prereg} {partition}',
    evaluate: 'python -m search.evaluate {prereg}',
    reproduce: 'python -m search.reproduce {prereg}',
  },
  feeds: ['https://export.arxiv.org/rss/astro-ph'],
}

const parse = (research: unknown) => parseRepoConfig(JSON.stringify({ stack: 'Python', research }), source).research
const research = (patch: Record<string, unknown>) => ({ ...example, ...patch })
const commands = (patch: Record<string, unknown>) => research({ commands: { ...example.commands, ...patch } })

function rejects(value: unknown, key: string, problem: RegExp) {
  assert.throws(
    () => parse(value),
    (error: unknown) => {
      assert.ok(error instanceof StopError, String(error))
      assert.ok(error.message.startsWith(`${source}: ${key} `), error.message)
      assert.match(error.message, problem)
      return true
    },
  )
}

test('the example of section 6.3 parses as written', () => {
  assert.deepEqual(parse(example), example)
  assert.deepEqual(parseResearchConfig(example, source), example)
})

test('a config without research is the same as before', () => {
  const text = JSON.stringify({ stack: 'TypeScript', checks: { typecheck: 'npm run check' }, tests: null })
  const config = parseRepoConfig(text, source)
  assert.deepEqual(config, JSON.parse(text))
  assert.equal('research' in config, false)
})

test('research must be an object, and unknown keys are errors at each level', () => {
  rejects(null, 'research', /must be an object/)
  rejects([], 'research', /must be an object/)
  rejects('research', 'research', /must be an object/)
  rejects(research({ sweep: 'x' }), 'research.sweep', /not a known key/)
  rejects(research({ lenses: { ...example.lenses, writer: ['x'] } }), 'research.lenses.writer', /not a known key/)
  rejects(commands({ screen: 'x' }), 'research.commands.screen', /not a known key/)
  rejects(research({ lenses: undefined }), 'research.lenses', /must be an object/)
  rejects(research({ commands: [] }), 'research.commands', /must be an object/)
})

test('egress takes only host names, lowercased, without repeats', () => {
  assert.deepEqual(parse(research({ egress: ['Archive.Example.ORG', 'localhost'] }))?.egress, ['archive.example.org', 'localhost'])
  rejects(research({ egress: [] }), 'research.egress', /non-empty list/)
  rejects(research({ egress: 'archive.example.org' }), 'research.egress', /non-empty list/)
  rejects(research({ egress: ['a.org', ''] }), 'research.egress[1]', /non-empty string/)
  rejects(research({ egress: ['a.org', 7] }), 'research.egress[1]', /non-empty string/)
  for (const host of ['https://a.org', 'a.org/data', 'a.org:443', 'user@a.org', 'a.org?q=1', 'a .org', 'a..org', '-a.org', 'a.org.', '*.a.org'])
    rejects(research({ egress: ['b.org', host] }), 'research.egress[1]', /host name only/)
  rejects(research({ egress: ['a.org', 'A.org'] }), 'research.egress[1]', /repeats the host a\.org/)
})

test('lenses and prereg sections are non-empty lists of non-empty strings', () => {
  rejects(research({ lenses: { ...example.lenses, survey: [] } }), 'research.lenses.survey', /non-empty list/)
  rejects(research({ lenses: { survey: ['x'] } }), 'research.lenses.skeptic', /non-empty list/)
  rejects(research({ lenses: { ...example.lenses, skeptic: ['x', ' '] } }), 'research.lenses.skeptic[1]', /non-empty string/)
  rejects(research({ prereg_sections: 'Holdout' }), 'research.prereg_sections', /non-empty list/)
  rejects(research({ prereg_sections: ['Holdout', null] }), 'research.prereg_sections[1]', /non-empty string/)
})

test('commands need known, inject, evaluate and reproduce, and use only {prereg}, and {partition} only in sweep', () => {
  const { sweep: _, ...required } = example.commands
  assert.deepEqual(parse(research({ commands: required }))?.commands, required)
  assert.equal('sweep' in (parse(research({ commands: required }))?.commands ?? {}), false)
  assert.deepEqual(parse(commands({ known: 'make known', inject: 'make inject' }))?.commands.known, 'make known')
  for (const name of ['known', 'inject', 'evaluate', 'reproduce']) {
    rejects(commands({ [name]: undefined }), `research.commands.${name}`, /non-empty string/)
    rejects(commands({ [name]: '' }), `research.commands.${name}`, /non-empty string/)
    rejects(commands({ [name]: 'run {partition}' }), `research.commands.${name}`, /placeholder \{partition\}, but only \{prereg\} are permitted/)
  }
  rejects(commands({ sweep: '' }), 'research.commands.sweep', /non-empty string/)
  rejects(commands({ sweep: 'run {prereg} {target}' }), 'research.commands.sweep', /placeholder \{target\}, but only \{prereg\} and \{partition\}/)
  rejects(commands({ known: 'run {Prereg}' }), 'research.commands.known', /placeholder \{Prereg\}/)
})

test('a shell ${VAR} in a command is not a placeholder', () => {
  const command = 'DATA=${DATA_DIR:-data} python -m search.known {prereg} --out ${OUT}'
  assert.equal(parse(commands({ known: command }))?.commands.known, command)
  assert.equal(parse(commands({ known: 'echo {not a placeholder} { x }' }))?.commands.known, 'echo {not a placeholder} { x }')
})

test('paths are normalized relative to the repository root', () => {
  const parsed = parse(research({ holdout: 'research/../research/holdout.json', guides: './research//guides/', checklist: 'a/./b/../checklist.md' }))
  assert.deepEqual([parsed?.holdout, parsed?.guides, parsed?.checklist], ['research/holdout.json', 'research/guides', 'a/checklist.md'])
  for (const key of ['holdout', 'guides', 'checklist']) {
    rejects(research({ [key]: '' }), `research.${key}`, /non-empty string/)
    rejects(research({ [key]: 7 }), `research.${key}`, /non-empty string/)
    rejects(research({ [key]: '/etc/passwd' }), `research.${key}`, /relative to the repository root/)
    rejects(research({ [key]: 'research\\holdout.json' }), `research.${key}`, /backslash/)
    rejects(research({ [key]: '../notebook/x' }), `research.${key}`, /goes above the repository root/)
    rejects(research({ [key]: 'research/../../x' }), `research.${key}`, /goes above the repository root/)
    rejects(research({ [key]: './research/..//' }), `research.${key}`, /names the repository root/)
    rejects(research({ [key]: '.' }), `research.${key}`, /names the repository root/)
  }
})

test('credentials map an egress host to a header and the name of an environment variable', () => {
  const credentials = { 'Archive.Example.org': { header: 'X-API-Key', secret: 'ARCHIVE_KEY' } }
  assert.deepEqual(parse(research({ credentials }))?.credentials, { 'archive.example.org': { header: 'X-API-Key', secret: 'ARCHIVE_KEY' } })
  const at = 'research.credentials["other.org"]'
  const bad = (credential: unknown, host = 'other.org') => research({ egress: ['other.org'], credentials: { [host]: credential } })
  rejects(research({ credentials: [] }), 'research.credentials', /must be an object/)
  rejects(research({ egress: ['export.arxiv.org'], credentials }), 'research.credentials["Archive.Example.org"]', /not in research.egress/)
  rejects(bad({ header: 'X-Key', secret: 'KEY' }, 'sub.other.org'), 'research.credentials["sub.other.org"]', /not in research.egress/)
  rejects(research({ egress: ['other.org'], credentials: { 'other.org': { header: 'A', secret: 'B' }, 'OTHER.org': { header: 'A', secret: 'B' } } }), 'research.credentials["OTHER.org"]', /repeats the host other\.org/)
  rejects(bad('KEY'), at, /must be an object/)
  rejects(bad({ header: 'X-Key', secret: 'KEY', value: 'sk-1' }), `${at}.value`, /not a known key/)
  rejects(bad({ secret: 'KEY' }), `${at}.header`, /non-empty string/)
  rejects(bad({ header: 'X Key', secret: 'KEY' }), `${at}.header`, /HTTP header name/)
  rejects(bad({ header: 'X-Key:', secret: 'KEY' }), `${at}.header`, /HTTP header name/)
  rejects(bad({ header: 'X-Key', secret: '' }), `${at}.secret`, /non-empty string/)
  rejects(bad({ header: 'X-Key', secret: 'sk-ant-123' }), `${at}.secret`, /name of an environment variable/)
  rejects(bad({ header: 'X-Key', secret: '1KEY' }), `${at}.secret`, /name of an environment variable/)
  rejects(bad({ header: 'X-Key', secret: 'GITHUB_TOKEN' }), `${at}.secret`, /secret of the host/)
})

test('feeds are normalized https URLs without repeats, and their hosts need not be in egress', () => {
  const feeds = ['HTTPS://Feeds.Other.ORG:443/rss', 'https://export.arxiv.org/rss/astro-ph']
  assert.deepEqual(parse(research({ feeds }))?.feeds, ['https://feeds.other.org/rss', 'https://export.arxiv.org/rss/astro-ph'])
  const { feeds: _, ...without } = example
  assert.equal('feeds' in (parse(without) ?? {}), false)
  rejects(research({ feeds: [] }), 'research.feeds', /non-empty list/)
  rejects(research({ feeds: 'https://export.arxiv.org/rss/astro-ph' }), 'research.feeds', /non-empty list/)
  rejects(research({ feeds: ['https://a.org/rss', 7] }), 'research.feeds[1]', /non-empty string/)
  rejects(research({ feeds: ['https://a.org/rss', 'http://a.org/rss'] }), 'research.feeds[1]', /https URL/)
  rejects(research({ feeds: ['https://a.org/rss', 'a.org/rss'] }), 'research.feeds[1]', /https URL/)
  rejects(research({ feeds: ['https://a.org/rss', 'https://user@a.org/rss'] }), 'research.feeds[1]', /user or a password/)
  rejects(research({ feeds: ['https://a.org/rss', 'https://A.org:443/rss'] }), 'research.feeds[1]', /repeats the URL https:\/\/a\.org\/rss/)
})

/** Files in memory: `list` gives the files directly in a directory, or null when no file is under it. */
const memory = (tree: Record<string, string>): ResearchFiles => ({
  read: async (path) => tree[path] ?? null,
  list: async (dir) => {
    const paths = Object.keys(tree).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1))
    return paths.length === 0 ? null : paths.filter((name) => !name.includes('/'))
  },
})

const config: ResearchConfig = parseResearchConfig(example, source)
const holdout = { refuse: ['https://archive.example.org/api/target?id=42', 'https://EXPORT.arxiv.org/abs/'], targets: ['T-42', 'T-43'] }
const notebook = {
  'research/holdout.json': JSON.stringify(holdout),
  'research/checklist.md': '- Instrument artifacts\n- Known objects\n',
  'research/guides/archive.md': '# Archive\n',
  'research/guides/statistics.md': '# Statistics\n',
  'research/guides/notes.txt': 'not a guide',
  'research/guides/old/legacy.md': 'not top-level',
}
const load = (patch: Record<string, string | undefined>) =>
  loadResearchDomain(config, memory(Object.fromEntries(Object.entries({ ...notebook, ...patch }).filter((entry): entry is [string, string] => entry[1] !== undefined))), 'on main')

async function loadRejects(patch: Record<string, string | undefined>, file: string, problem: RegExp) {
  await assert.rejects(load(patch), (error: unknown) => {
    assert.ok(error instanceof StopError, String(error))
    assert.ok(error.message.startsWith(`${file} on main: `), error.message)
    assert.match(error.message, problem)
    return true
  })
}

test('the loader returns the config, the holdout with normalized prefixes, the checklist items and the top-level .md guides', async () => {
  const domain = await load({})
  assert.equal(domain.config, config)
  assert.deepEqual(domain.holdout, { ...holdout, refuse: ['https://archive.example.org/api/target?id=42', 'https://export.arxiv.org/abs/'] })
  assert.deepEqual(domain.checklist, ['Instrument artifacts', 'Known objects'])
  assert.deepEqual(Object.keys(domain.guides).sort(), ['archive.md', 'statistics.md'])
  assert.equal(domain.guides['statistics.md'], '# Statistics\n')
})

test('a missing or bad holdout file stops with its path', async () => {
  const file = 'research/holdout.json'
  const with_ = (value: unknown) => ({ [file]: JSON.stringify(value) })
  await loadRejects({ [file]: undefined }, file, /does not exist/)
  await loadRejects({ [file]: '{"refuse": [' }, file, /not valid JSON/)
  await loadRejects(with_(['https://archive.example.org/']), file, /the file must be an object/)
  await loadRejects(with_({ ...holdout, ranges: [] }), file, /: ranges is not a known key/)
  await loadRejects(with_({ targets: ['T-1'] }), file, /refuse must be a non-empty list/)
  await loadRejects(with_({ ...holdout, refuse: [] }), file, /refuse must be a non-empty list/)
  await loadRejects(with_({ ...holdout, targets: [] }), file, /targets must be a non-empty list/)
  await loadRejects(with_({ ...holdout, targets: 'T-42' }), file, /targets must be a non-empty list/)
  await loadRejects(with_({ ...holdout, targets: ['T-42', ''] }), file, /targets\[1\] must be a non-empty string/)
})

test('each holdout prefix is an https URL on an egress host, not on a subdomain', async () => {
  const file = 'research/holdout.json'
  const refuse = (prefix: string) => ({ [file]: JSON.stringify({ ...holdout, refuse: [holdout.refuse[0], prefix] }) })
  await loadRejects(refuse('http://archive.example.org/api'), file, /refuse\[1\] must be an https URL prefix/)
  await loadRejects(refuse('ftp://archive.example.org/'), file, /refuse\[1\] must be an https URL prefix/)
  await loadRejects(refuse('archive.example.org/api'), file, /refuse\[1\] must be an https URL prefix/)
  await loadRejects(refuse('https://data.archive.example.org/api'), file, /refuse\[1\] must be on a host of research.egress, not data\.archive\.example\.org/)
  await loadRejects(refuse('https://example.org/'), file, /refuse\[1\] must be on a host of research.egress/)
  await loadRejects(refuse('https://user@archive.example.org/x'), file, /refuse\[1\] must not have a user or a password/)
  await loadRejects(refuse('https://archive.example.org/x#frag'), file, /refuse\[1\] must not have a fragment/)
  // The egress compares normalized request URLs, so the loader gives each prefix in normalized form.
  assert.deepEqual((await load(refuse('https://Archive.Example.org:443/x'))).holdout.refuse[1], 'https://archive.example.org/x')
})

test('each top-level list item of the checklist is one item, with its nested and continuation lines', async () => {
  const text = [
    'Intro text that is not an item.',
    '',
    '- Instrument artifacts',
    '  - cosmic rays',
    '  - saturated pixels',
    '* Known objects',
    'that continue here',
    '',
    'A paragraph ends the item.',
    '1. Contamination',
    '',
    '   with a second paragraph',
    '2) Statistics',
    '## Notes',
    '  - an indented top-level item',
    '+ Last',
    '-not an item',
  ].join('\n')
  const domain = await load({ 'research/checklist.md': text })
  assert.deepEqual(domain.checklist, [
    'Instrument artifacts\n- cosmic rays\n- saturated pixels',
    'Known objects\nthat continue here',
    'Contamination\nwith a second paragraph',
    'Statistics',
    'an indented top-level item',
    'Last\n-not an item',
  ])
})

test('a top-level list marker can have up to 3 spaces before it and a tab after it', async () => {
  const items = async (text: string) => (await load({ 'research/checklist.md': text })).checklist
  assert.deepEqual(await items(' - a\n - b\n'), ['a', 'b'])
  assert.deepEqual(await items('-\ttab item\n'), ['tab item'])
  assert.deepEqual(await items('1. a\n  2. b\n'), ['a', 'b'])
})

test('a list marker in a code fence does not start a checklist item', async () => {
  const file = 'research/checklist.md'
  const items = async (text: string) => (await load({ [file]: text })).checklist
  await loadRejects({ [file]: '```\n- Example\n```\n' }, file, /no top-level list item/)
  assert.deepEqual(await items('- Real\n```\n- Example\n```\n'), ['Real'])
  assert.deepEqual(await items('~~~\n- Example\n~~~\n- Real\n'), ['Real'])
  // A fence indented under an item stays in that item.
  assert.deepEqual(await items('- Real\n  ```\n  - code\n  ```\n'), ['Real\n```\n- code\n```'])
})

test('fences permit at most three spaces of indent relative to the current list item', async () => {
  const items = async (text: string) => (await load({ 'research/checklist.md': text })).checklist
  for (const fence of ['```', '~~~']) {
    assert.deepEqual(await items(`    ${fence}\n\n- Real\n`), ['Real'])
    assert.deepEqual(await items(`- First\n      ${fence}\n\n- Real\n`), [`First\n${fence}`, 'Real'])
    assert.deepEqual(await items(`   ${fence}\n- Example\n   ${fence}\n- Real\n`), ['Real'])
    assert.deepEqual(await items(`- Real\n     ${fence}\n  - code\n     ${fence}\n- Next\n`), [`Real\n${fence}\n- code\n${fence}`, 'Next'])
    assert.deepEqual(await items(`${fence}\n    ${fence}\n- Example\n${fence}\n- Real\n`), ['Real'])
    assert.deepEqual(await items(`- Real\n  ${fence}\n      ${fence}\n  - code\n  ${fence}\n- Next\n`), [`Real\n${fence}\n${fence}\n- code\n${fence}`, 'Next'])
  }
})

test('a fence on the list marker line stays in its checklist item', async () => {
  const items = async (text: string) => (await load({ 'research/checklist.md': text })).checklist
  for (const fence of ['```', '~~~']) {
    assert.deepEqual(await items(`- ${fence}\n  sample\n  ${fence}\n- Real\n`), [`${fence}\nsample\n${fence}`, 'Real'])
    assert.deepEqual(await items(`1. ${fence}\n   - code\n   ${fence}\n2. Real\n`), [`${fence}\n- code\n${fence}`, 'Real'])
    assert.deepEqual(await items(`-     ${fence}\n- Real\n`), [fence, 'Real'])
  }
})

test('an item-local fence ends when its list container ends', async () => {
  const items = async (text: string) => (await load({ 'research/checklist.md': text })).checklist
  for (const fence of ['```', '~~~']) {
    assert.deepEqual(await items(`- First\n  ${fence}\n  sample\n- Second\n- Third\n`), [`First\n${fence}\nsample`, 'Second', 'Third'])
    assert.deepEqual(await items(`- ${fence}\n  sample\n\n- Second\n`), [`${fence}\nsample`, 'Second'])
    assert.deepEqual(await items(`- First\n  ${fence}\n\n  - code\n- Second\n`), [`First\n${fence}\n- code`, 'Second'])
    assert.deepEqual(await items(`- First\n  ${fence}\n  sample\nOutside the item.\n- Second\n`), [`First\n${fence}\nsample`, 'Second'])
    assert.deepEqual(await items(`1. First\n   ${fence}\n   sample\n  2. Second\n`), [`First\n${fence}\nsample`, 'Second'])
  }
})

test('a missing checklist, or a checklist without items, stops with its path', async () => {
  const file = 'research/checklist.md'
  await loadRejects({ [file]: undefined }, file, /does not exist/)
  await loadRejects({ [file]: '# Checklist\n\nNo items here.\n    - four spaces of indent\n' }, file, /no top-level list item/)
})

test('a missing guides directory, or one without .md files, stops with its path', async () => {
  const dir = 'research/guides'
  const none = { 'research/guides/archive.md': undefined, 'research/guides/statistics.md': undefined }
  await loadRejects({ ...none, 'research/guides/notes.txt': undefined, 'research/guides/old/legacy.md': undefined }, dir, /directory does not exist/)
  await loadRejects(none, dir, /directory has no \.md file/)
})
