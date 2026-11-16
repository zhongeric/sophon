import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignIds, checkFindings, parseLocation } from '../src/core/findings.ts'
import { memoryArtifacts } from './support/artifacts.ts'

const file = ['export function withdraw(amount: uint) {', '  token.transfer(msg.sender, amount)', '  balances[msg.sender] -= amount', '}'].join('\n')
const sources = {
  read: async (path: string) => (path === 'src/Vault.ts' ? file : null),
  diff: [
    'diff --git a/src/Other.ts b/src/Other.ts',
    '+  emit Withdrawn(amount)',
    'diff --git a/src/Vault.ts b/src/Vault.ts',
    '+++ b/src/Vault.ts',
    '-  require(ok)',
    '+  token.transfer(msg.sender, amount)',
  ].join('\n'),
}
const finding = {
  location: 'src/Vault.ts:2',
  title: 'Update the balance before the transfer',
  trigger: 'a token with a transfer hook reenters withdraw',
  impact: 'drains the vault',
  severity: 'critical',
  evidence: 'token.transfer(msg.sender, amount) ... balances[msg.sender] -= amount',
  recommendation: 'move the balance update above the transfer',
}

test('a finding with a quote from the file passes', async () => {
  assert.deepEqual(await checkFindings({ findings: [finding] }, sources), { findings: [finding], errors: [] })
})

test('quotes may carry line-number gutters, span lines, or come from deleted diff lines', async () => {
  const variants = ['  2\ttoken.transfer(msg.sender, amount)\n  3\tbalances[msg.sender] -= amount', 'require(ok) ... -= amount']
  for (const evidence of variants) assert.deepEqual((await checkFindings({ findings: [{ ...finding, evidence }] }, sources)).errors, [])
})

test('the evidence rule rejects missing fields, unknown files, and quotes that are not in the code', async () => {
  const { trigger: _trigger, ...noTrigger } = finding
  const { errors } = await checkFindings(
    {
      findings: [
        noTrigger,
        { ...finding, location: 'src/Gone.ts:2' },
        { ...finding, evidence: 'balances[msg.sender] = 0' },
        { ...finding, severity: 'urgent' },
        { ...finding, evidence: '}' },
        { ...finding, evidence: 'emit Withdrawn(amount)' },
        { ...finding, needs_decision: true },
      ],
    },
    sources,
  )
  assert.deepEqual(errors, [
    'findings[0]: missing trigger',
    'findings[1]: location "src/Gone.ts:2": src/Gone.ts does not exist in the reviewed tree',
    'findings[2]: evidence "balances[msg.sender] = 0" is not in src/Vault.ts near line 2, or in its diff. Quote code that you read.',
    'findings[3]: severity must be one of critical, high, medium, low, info',
    'findings[4]: evidence "}" is too short: quote at least 8 non-space characters of code',
    'findings[5]: evidence "emit Withdrawn(amount)" is not in src/Vault.ts near line 2, or in its diff. Quote code that you read.',
    'findings[6]: needs_decision needs the decision, in one sentence',
  ])
})

test('locations are path:line or path:start-end, relative to /repo', () => {
  assert.deepEqual(parseLocation('/repo/src/a.ts:3-9'), { path: 'src/a.ts', start: 3, end: 9 })
  assert.deepEqual(parseLocation('./src/a.ts:3'), { path: 'src/a.ts', start: 3, end: 3 })
  assert.equal(parseLocation('src/a.ts'), null)
  assert.equal(parseLocation('src/a.ts:9-3'), null)
})

const store = memoryArtifacts()
const fetched = { source: { url: 'https://example.com/paper', method: 'GET' }, media_type: 'text/plain' }
const put = (bytes: Uint8Array) => store.put(bytes, fetched)
const report = Array.from({ length: 60 }, (_, index) => `row ${index + 1}: fee rate of the vault`)
report[1] = 'the withdraw fee is 0.3 percent of the amount'
report[49] = 'the deposit fee is 0.1 percent of the amount'
const artifactSources = { ...sources, artifact: (id: string) => store.get(id) }
const reportId = await put(new TextEncoder().encode(report.join('\n')))
const artifactFinding = { ...finding, location: `artifact:${reportId}:2`, evidence: 'the withdraw fee is 0.3 percent' }

test('artifact locations are artifact:<id>, artifact:<id>:line or artifact:<id>:start-end, with a valid ID', () => {
  const id = 'a'.repeat(64)
  assert.deepEqual(parseLocation(`artifact:${id}`), { artifact: id, lines: null })
  assert.deepEqual(parseLocation(` artifact:${id}:7 `), { artifact: id, lines: { start: 7, end: 7 } })
  assert.deepEqual(parseLocation(`artifact:${id}:3-9`), { artifact: id, lines: { start: 3, end: 9 } })
  for (const bad of [`artifact:${id.slice(1)}`, 'artifact:report.txt', `artifact:${id}:9-3`, `artifact:${id}:0`, `artifact:${id}:`]) {
    assert.equal(parseLocation(bad), null, bad)
  }
  assert.deepEqual(parseLocation('artifact:notes.md:3'), { path: 'artifact:notes.md', start: 3, end: 3 })
  assert.deepEqual(parseLocation(`artifact:${'A'.repeat(64)}:3`), { path: `artifact:${'A'.repeat(64)}`, start: 3, end: 3 })
})

test('a finding with a quote from an artifact passes, and its location is normalized', async () => {
  const cases = [
    [`artifact:${reportId}`, `artifact:${reportId}`],
    [` artifact:${reportId}:2 `, `artifact:${reportId}:2`],
    [`artifact:${reportId}:2-2`, `artifact:${reportId}:2`],
    [`artifact:${reportId}:1-3`, `artifact:${reportId}:1-3`],
  ]
  for (const [location, normalized] of cases) {
    const result = await checkFindings({ findings: [{ ...artifactFinding, location }] }, artifactSources)
    assert.deepEqual(result, { findings: [{ ...artifactFinding, location: normalized }], errors: [] }, location)
  }
  const gutters = { ...artifactFinding, evidence: '  2\tthe withdraw fee is 0.3 ... 3→row 3: fee rate' }
  assert.deepEqual((await checkFindings({ findings: [gutters] }, artifactSources)).errors, [])
})

test('artifact readers keep their receiver and read each artifact one time', async () => {
  const methodSources = {
    ...sources,
    store,
    reads: 0,
    artifact(id: string) {
      this.reads += 1
      return this.store.get(id)
    },
  }
  const findings = [artifactFinding, { ...artifactFinding, location: `artifact:${reportId}` }]
  assert.deepEqual(await checkFindings({ findings }, methodSources), { findings, errors: [] })
  assert.equal(methodSources.reads, 1)
})

test('with a line, an artifact quote must be near that line. Without a line, it can be anywhere', async () => {
  const far = { ...artifactFinding, evidence: 'the deposit fee is 0.1 percent' }
  assert.deepEqual((await checkFindings({ findings: [far] }, artifactSources)).errors, [
    `findings[0]: evidence "the deposit fee is 0.1 percent" is not in artifact ${reportId} near line 2. Quote text that you read.`,
  ])
  assert.deepEqual((await checkFindings({ findings: [{ ...far, location: `artifact:${reportId}` }] }, artifactSources)).errors, [])
})

test('the evidence check rejects bad artifact quotes, unknown and binary artifacts, and reviews with no artifact store', async () => {
  const withNul = await put(new Uint8Array([0x61, 0x62, 0x00, 0x63]))
  const invalidUtf8 = await put(new Uint8Array([0x61, 0xff, 0x62]))
  const unknown = '0'.repeat(64)
  const { errors } = await checkFindings(
    {
      findings: [
        { ...artifactFinding, evidence: 'the withdraw fee is 5 percent' },
        { ...artifactFinding, location: `artifact:${reportId}`, evidence: 'the withdraw fee is 5 percent' },
        { ...artifactFinding, location: `artifact:${reportId}:61` },
        { ...artifactFinding, location: `artifact:${unknown}:2` },
        { ...artifactFinding, location: `artifact:${withNul}` },
        { ...artifactFinding, location: `artifact:${invalidUtf8}:1` },
        { ...artifactFinding, evidence: 'the withdraw fee ... 0.3' },
        { ...artifactFinding, location: 'artifact:report.txt' },
        { ...artifactFinding, evidence: 'token.transfer(msg.sender, amount)' },
      ],
    },
    artifactSources,
  )
  assert.deepEqual(errors, [
    `findings[0]: evidence "the withdraw fee is 5 percent" is not in artifact ${reportId} near line 2. Quote text that you read.`,
    `findings[1]: evidence "the withdraw fee is 5 percent" is not in artifact ${reportId}. Quote text that you read.`,
    `findings[2]: location "artifact:${reportId}:61": the artifact has 60 lines`,
    `findings[3]: location "artifact:${unknown}:2": artifact ${unknown} does not exist in the run store`,
    `findings[4]: location "artifact:${withNul}": artifact ${withNul} is binary, and the evidence check reads only UTF-8 text`,
    `findings[5]: location "artifact:${invalidUtf8}:1": artifact ${invalidUtf8} is binary, and the evidence check reads only UTF-8 text`,
    'findings[6]: evidence "0.3" is too short: quote at least 8 non-space characters of text',
    'findings[7]: location "artifact:report.txt" is not path:line, path:start-end, artifact:<id>, artifact:<id>:line or artifact:<id>:start-end',
    `findings[8]: evidence "token.transfer(msg.sender, amount)" is not in artifact ${reportId} near line 2. Quote text that you read.`,
  ])
  assert.deepEqual((await checkFindings({ findings: [artifactFinding] }, sources)).errors, [
    `findings[0]: location "artifact:${reportId}:2": this review has no artifact store`,
  ])
  assert.deepEqual((await checkFindings({ findings: [{ ...finding, location: 'src/Vault.ts' }] }, sources)).errors, [
    'findings[0]: location "src/Vault.ts" is not path:line or path:start-end',
  ])
})

test('quotes of table rows that start with a number and a pipe or a tab pass, and the store reads the artifact one time', async () => {
  const table = await put(new TextEncoder().encode(['1|alice|admin', '2|bob|user', '12|bob|25', '3\tcarol\tguest', '12345678|'].join('\n')))
  let reads = 0
  const counted = {
    ...sources,
    artifact: (id: string) => {
      reads += 1
      return store.get(id)
    },
  }
  const quotes = [
    [`artifact:${table}:1-2`, '1|alice|admin\n2|bob|user'],
    [`artifact:${table}:3`, '12|bob|25'],
    [`artifact:${table}`, '2|bob|user\n12|bob|25\n3\tcarol\tguest'],
    [`artifact:${table}:5`, '12345678|'],
    [`artifact:${table}`, '12345678|'],
  ]
  const { errors } = await checkFindings({ findings: quotes.map(([location, evidence]) => ({ ...finding, location, evidence })) }, counted)
  assert.deepEqual(errors, [])
  assert.equal(reads, 1)
  const rejected = [
    { ...finding, location: `artifact:${table}:3`, evidence: '12|bob|26' },
    { ...finding, location: `artifact:${table}:3`, evidence: '1|bob' },
  ]
  assert.deepEqual((await checkFindings({ findings: rejected }, counted)).errors, [
    `findings[0]: evidence "12|bob|26" is not in artifact ${table} near line 3. Quote text that you read.`,
    'findings[1]: evidence "1|bob" is too short: quote at least 8 non-space characters of text',
  ])
})

test('invalid artifact IDs with a line give a format error unless the file exists', async () => {
  const locations = ['artifact:3fa9c1d2e4b7:12', `artifact:${'A'.repeat(64)}:2`, 'artifact:report.txt:2']
  for (const location of locations) {
    assert.deepEqual((await checkFindings({ findings: [{ ...artifactFinding, location }] }, artifactSources)).errors, [
      `findings[0]: location "${location}" is not path:line, path:start-end, artifact:<id>, artifact:<id>:line or artifact:<id>:start-end`,
    ])
  }
  const location = 'artifact:notes.md:2'
  const fileSources = { ...artifactSources, read: async (path: string) => (path === 'artifact:notes.md' ? file : null) }
  const fileFinding = { ...finding, location }
  assert.deepEqual(await checkFindings({ findings: [fileFinding] }, fileSources), { findings: [fileFinding], errors: [] })
  assert.deepEqual((await checkFindings({ findings: [fileFinding] }, sources)).errors, [
    'findings[0]: location "artifact:notes.md:2": artifact:notes.md does not exist in the reviewed tree',
  ])
})

test('IDs come from the role prefix and the position', () => {
  const [first] = assignIds([finding as never], 'bugs', 'late-bugs')
  assert.equal(first?.id, 'late-bugs-001')
  assert.equal(first?.track, 'bugs')
})
