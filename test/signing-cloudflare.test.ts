import assert from 'node:assert/strict'
import { test } from 'node:test'
import { github, GitHubError } from '../src/cloudflare/github.ts'
import { githubSigning } from '../src/cloudflare/signing.ts'
import { signingLine } from '../src/core/signing.ts'
import { StopError } from '../src/core/stop.ts'

const branch = 'factory/dev-x'
const rules = `/repos/o/r/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=1`
const classic = `/repos/o/r/branches/${encodeURIComponent(branch)}/protection/required_signatures`

/** The signing adapter on the github() client and a fake fetch that answers each path from a script. A path without an answer gives 404. */
function scripted(answers: Record<string, () => Response>) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const path = String(input).replace('https://api.test', '')
    calls.push(path)
    return answers[path]?.() ?? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  const gh = github('token', 'https://api.test', fetcher, { sleep: async () => {} })
  return { calls, signing: githubSigning(gh, 'o', 'r') }
}

const answer = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status })

test('no branch gives unsigned commits without a call', async () => {
  const { calls, signing } = scripted({})
  assert.deepEqual(await signing.check([]), { branches: [], mode: 'unsigned', origin: true })
  assert.deepEqual(calls, [])
})

test('no rule and a classic 404 give unsigned commits and apply passes', async () => {
  const { calls, signing } = scripted({ [rules]: answer(200, []) })
  const record = await signing.check([branch])
  assert.deepEqual(record, { branches: [{ branch, classic: 'none', rulesets: [] }], mode: 'unsigned', origin: true })
  assert.deepEqual(calls, [rules, classic])
  await signing.apply(record)
})

test('a required_signatures rule stops in apply with the ruleset and the branch', async () => {
  const { signing } = scripted({
    [rules]: answer(200, [{ ruleset_id: 7, type: 'required_signatures' }]),
    '/repos/o/r/rulesets/7': answer(200, { id: 7, name: 'Protect main' }),
  })
  const record = await signing.check([branch])
  assert.equal(record.mode, 'signed')
  await assert.rejects(signing.apply(record), (error) => {
    assert.ok(error instanceof StopError)
    assert.match(error.message, /Protect main/)
    assert.match(error.message, /factory\/dev-x/)
    assert.match(error.message, /Git Data API/)
    assert.match(error.message, /local host/)
    return true
  })
})

test('classic protection with signatures enabled stops in apply', async () => {
  const { signing } = scripted({ [rules]: answer(200, []), [classic]: answer(200, { enabled: true }) })
  const record = await signing.check([branch])
  await assert.rejects(signing.apply(record), (error) => {
    assert.ok(error instanceof StopError)
    assert.match(error.message, /classic protection/)
    assert.match(error.message, /factory\/dev-x/)
    return true
  })
})

test('a classic 403 alone gives unsigned commits and says that classic protection is not readable', async () => {
  const { signing } = scripted({ [rules]: answer(200, []), [classic]: answer(403, { message: 'Resource not accessible by integration' }) })
  const record = await signing.check([branch])
  assert.deepEqual(record, { branches: [{ branch, classic: 'unreadable', rulesets: [] }], mode: 'unsigned', origin: true })
  assert.equal(signingLine(record), 'Commits: unsigned (no signature rule, classic protection not readable)')
  await signing.apply(record)
})

test('a 403 from the rules endpoint stops in check', async () => {
  const { signing } = scripted({ [rules]: answer(403, { message: 'Forbidden' }) })
  await assert.rejects(signing.check([branch]), (error) => error instanceof StopError && /403/.test(error.message) && error.message.includes(rules))
})

test('the 403 of a private repository whose plan has no rulesets or branch protection gives unsigned commits', async () => {
  const upgrade = answer(403, { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.', status: '403' })
  const { signing } = scripted({ [rules]: upgrade, [classic]: upgrade })
  const record = await signing.check([branch])
  assert.deepEqual(record, { branches: [{ branch, classic: 'none', rulesets: [] }], mode: 'unsigned', origin: true })
  await signing.apply(record)
})

// Not a StopError: the run loop tries the run again.
test('a 500 that stays after the retries rejects in check without a StopError', async () => {
  const { calls, signing } = scripted({ [rules]: answer(500, { message: 'Server Error' }) })
  await assert.rejects(signing.check([branch]), (error) => error instanceof Error && !(error instanceof StopError) && /500/.test(error.message))
  assert.deepEqual(calls, [rules, rules, rules])
})

test('a rate limit on the rules endpoint rejects in check with the GitHubError', async () => {
  const limited = () => new Response('{}', { headers: { 'retry-after': '3600' }, status: 429 })
  const { signing } = scripted({ [rules]: limited })
  await assert.rejects(signing.check([branch]), (error) => error instanceof GitHubError && error.rateLimited)
})
