import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commitMode, readSignatureRules, signingLine, type BranchRule, type GitHubAnswer } from '../src/core/signing.ts'
import { StopError } from '../src/core/stop.ts'

const api = '/repos/o/r'

/** A get that answers from a script. A path without an answer gives 404. */
function scripted(answers: Record<string, GitHubAnswer | Error>) {
  const calls: string[] = []
  const get = async (path: string): Promise<GitHubAnswer> => {
    calls.push(path)
    const answer = answers[path] ?? { status: 404, body: { message: 'Not Found' } }
    if (answer instanceof Error) throw answer
    return answer
  }
  return { get, calls }
}

const rules = (branch: string, page = 1) => `${api}/rules/branches/${encodeURIComponent(branch)}?per_page=100&page=${page}`
const classic = (branch: string) => `${api}/branches/${encodeURIComponent(branch)}/protection/required_signatures`
const signatureRule = (id: number) => ({ type: 'required_signatures', ruleset_id: id, ruleset_source_type: 'Repository', ruleset_source: 'o/r' })

test('no rule and a classic 404 give unsigned commits', async () => {
  const { get, calls } = scripted({ [rules('main')]: { status: 200, body: [{ type: 'deletion', ruleset_id: 1 }] } })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches, [{ branch: 'main', rulesets: [], classic: 'none' }])
  assert.equal(commitMode(branches, { signUnknown: true }), 'unsigned')
  assert.equal(signingLine({ origin: true, branches, mode: 'unsigned' }), 'Commits: unsigned (no signature rule)')
  assert.deepEqual(calls, [rules('main'), classic('main')])
})

test('a required_signatures rule gives signed commits with the ruleset name in the line', async () => {
  const { get, calls } = scripted({
    [rules('main')]: { status: 200, body: [signatureRule(7), { type: 'deletion', ruleset_id: 7 }] },
    [rules('dev')]: { status: 200, body: [signatureRule(7)] },
    [`${api}/rulesets/7`]: { status: 200, body: { id: 7, name: 'Protect main' } },
  })
  const branches = await readSignatureRules(get, api, ['main', 'dev'])
  assert.deepEqual(branches[0], { branch: 'main', rulesets: ['Protect main'], classic: 'none' })
  assert.equal(calls.filter((path) => path === `${api}/rulesets/7`).length, 1)
  const mode = commitMode(branches, { signUnknown: false })
  assert.equal(mode, 'signed')
  assert.equal(signingLine({ origin: true, branches, mode }), 'Commits: signed (required by Protect main)')
})

test('classic protection with signatures enabled gives signed commits', async () => {
  const { get } = scripted({
    [rules('main')]: { status: 200, body: [] },
    [classic('main')]: { status: 200, body: { enabled: true } },
  })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches, [{ branch: 'main', rulesets: [], classic: 'required' }])
  const mode = commitMode(branches, { signUnknown: false })
  assert.equal(mode, 'signed')
  assert.equal(signingLine({ origin: true, branches, mode }), 'Commits: signed (required by classic protection)')
})

test('classic protection with signatures disabled is no requirement', async () => {
  const { get } = scripted({
    [rules('main')]: { status: 200, body: [] },
    [classic('main')]: { status: 200, body: { enabled: false } },
  })
  assert.deepEqual(await readSignatureRules(get, api, ['main']), [{ branch: 'main', rulesets: [], classic: 'none' }])
})

test('a classic 403 is unreadable and signs only with signUnknown', async () => {
  const { get } = scripted({
    [rules('main')]: { status: 200, body: [] },
    [classic('main')]: { status: 403, body: { message: 'Resource not accessible by integration' } },
  })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches, [{ branch: 'main', rulesets: [], classic: 'unreadable' }])
  assert.equal(commitMode(branches, { signUnknown: true }), 'signed')
  assert.equal(commitMode(branches, { signUnknown: false }), 'unsigned')
})

test('the 403 of a private repository whose plan has no rulesets or branch protection is no rule', async () => {
  const upgrade = { status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.', status: '403' } }
  const { get, calls } = scripted({ [rules('main')]: upgrade, [classic('main')]: upgrade })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches, [{ branch: 'main', rulesets: [], classic: 'none' }])
  assert.equal(commitMode(branches, { signUnknown: true }), 'unsigned')
  assert.deepEqual(calls, [rules('main'), classic('main')])
  // gh on the local host gives the message as text.
  const text = { status: 403, body: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' }
  const local = scripted({ [rules('main')]: text, [classic('main')]: text })
  assert.deepEqual(await readSignatureRules(local.get, api, ['main']), [{ branch: 'main', rulesets: [], classic: 'none' }])
})

// A 429 or a 5xx can go away, so it is not a StopError and the run loop of the Cloudflare host tries the run again.
for (const status of [403, 429, 500]) {
  test(`a ${status} from the rules endpoint rejects the check`, async () => {
    const { get } = scripted({ [rules('main')]: { status, body: {} } })
    await assert.rejects(readSignatureRules(get, api, ['main']), (error: Error) => {
      assert.equal(error instanceof StopError, status === 403)
      assert.match(error.message, /branch main/)
      assert.ok(error.message.includes(rules('main')))
      assert.ok(error.message.includes(String(status)))
      return true
    })
  })
}

test('a 500 from the classic endpoint stops the run without a StopError', async () => {
  const { get } = scripted({ [rules('main')]: { status: 200, body: [] }, [classic('main')]: { status: 500, body: {} } })
  await assert.rejects(readSignatureRules(get, api, ['main']), (error: Error) => {
    assert.ok(!(error instanceof StopError))
    assert.ok(error.message.includes(classic('main')))
    assert.ok(error.message.includes('500'))
    return true
  })
})

test('a get without an answer rejects with its own error', async () => {
  const reset = new Error('connection reset')
  const { get } = scripted({ [rules('main')]: reset })
  await assert.rejects(readSignatureRules(get, api, ['main']), (error) => error === reset)
  const timeout = new Error('timeout')
  const classicFails = scripted({ [rules('main')]: { status: 200, body: [] }, [classic('main')]: timeout })
  await assert.rejects(readSignatureRules(classicFails.get, api, ['main']), (error) => error === timeout)
})

test('a required_signatures rule on the second page gives signed commits', async () => {
  const deletion = (id: number) => ({ type: 'deletion', ruleset_id: id })
  const { get, calls } = scripted({
    [rules('main')]: { status: 200, body: Array.from({ length: 100 }, (_, index) => deletion(index + 10)) },
    [rules('main', 2)]: { status: 200, body: [signatureRule(7)] },
    [`${api}/rulesets/7`]: { status: 200, body: { id: 7, name: 'Protect main' } },
  })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches, [{ branch: 'main', rulesets: ['Protect main'], classic: 'none' }])
  assert.deepEqual(calls.slice(0, 2), [rules('main'), rules('main', 2)])
})

const malformed: [string, Record<string, GitHubAnswer>][] = [
  ['a rule without a type', { [rules('main')]: { status: 200, body: [{ ruleset_id: 7 }] } }],
  ['a rule that is not an object', { [rules('main')]: { status: 200, body: ['required_signatures'] } }],
  ['a required_signatures rule without a ruleset_id', { [rules('main')]: { status: 200, body: [{ type: 'required_signatures', ruleset_id: '7' }] } }],
  ['a classic answer with a string enabled', { [rules('main')]: { status: 200, body: [] }, [classic('main')]: { status: 200, body: { enabled: 'true' } } }],
  ['a classic answer without enabled', { [rules('main')]: { status: 200, body: [] }, [classic('main')]: { status: 200, body: {} } }],
]
for (const [name, answers] of malformed) {
  test(`${name} stops the run`, async () => {
    const { get } = scripted(answers)
    await assert.rejects(readSignatureRules(get, api, ['main']), (error: Error) => error instanceof StopError && /branch main/.test(error.message))
  })
}

test('a failed ruleset name call gives the label ruleset <id>', async () => {
  const { get } = scripted({
    [rules('main')]: { status: 200, body: [signatureRule(3), signatureRule(4)] },
    [`${api}/rulesets/3`]: { status: 403, body: {} },
    [`${api}/rulesets/4`]: new Error('no answer'),
  })
  const branches = await readSignatureRules(get, api, ['main'])
  assert.deepEqual(branches[0]?.rulesets, ['ruleset 3', 'ruleset 4'])
})

test('the branch name is URL-encoded', async () => {
  const { get, calls } = scripted({ ['repos/o/r/rules/branches/factory%2Fdev-x?per_page=100&page=1']: { status: 200, body: [] } })
  await readSignatureRules(get, 'repos/o/r', ['factory/dev-x'])
  assert.deepEqual(calls, ['repos/o/r/rules/branches/factory%2Fdev-x?per_page=100&page=1', 'repos/o/r/branches/factory%2Fdev-x/protection/required_signatures'])
})

test('signingLine gives each form of the Commits line', () => {
  const rule = (classic: BranchRule['classic'], rulesets: string[] = [], branch = 'main'): BranchRule => ({ branch, rulesets, classic })
  assert.equal(signingLine({ origin: false, branches: [], mode: 'unsigned' }), 'Commits: unsigned (no GitHub origin)')
  assert.equal(signingLine({ origin: true, branches: [], mode: 'unsigned' }), 'Commits: unsigned (no pushed branch)')
  assert.equal(signingLine({ origin: true, branches: [rule('none')], mode: 'unsigned' }), 'Commits: unsigned (no signature rule)')
  assert.equal(
    signingLine({ origin: true, branches: [rule('required', ['Protect main']), rule('none', ['Protect main', 'Other'], 'dev')], mode: 'signed' }),
    'Commits: signed (required by Protect main, classic protection, Other)',
  )
  assert.equal(signingLine({ origin: true, branches: [rule('unreadable')], mode: 'signed' }), 'Commits: signed (classic protection not readable)')
  assert.equal(
    signingLine({ origin: true, branches: [rule('unreadable', ['Protect main'])], mode: 'signed' }),
    'Commits: signed (required by Protect main, classic protection not readable)',
  )
  assert.equal(signingLine({ origin: true, branches: [rule('unreadable')], mode: 'unsigned' }), 'Commits: unsigned (no signature rule, classic protection not readable)')
})
