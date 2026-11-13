import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignIds, checkFindings, parseLocation } from '../src/core/findings.ts'

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
  ])
})

test('locations are path:line or path:start-end, relative to /repo', () => {
  assert.deepEqual(parseLocation('/repo/src/a.ts:3-9'), { path: 'src/a.ts', start: 3, end: 9 })
  assert.deepEqual(parseLocation('./src/a.ts:3'), { path: 'src/a.ts', start: 3, end: 3 })
  assert.equal(parseLocation('src/a.ts'), null)
  assert.equal(parseLocation('src/a.ts:9-3'), null)
})

test('IDs come from the role prefix and the position', () => {
  const [first] = assignIds([finding as never], 'bugs', 'late-bugs')
  assert.equal(first?.id, 'late-bugs-001')
  assert.equal(first?.track, 'bugs')
})
