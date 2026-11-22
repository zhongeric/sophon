import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRepo, parseTarget, pruneOutcome, remoteRequest, resumeOutcome } from '../src/node/remote.ts'

test('a PR or an issue is owner/repo#number or its GitHub URL', () => {
  assert.deepEqual(parseTarget('acme/app#7'), { owner: 'acme', pr: 7, repo: 'app' })
  assert.deepEqual(parseTarget('https://github.com/acme/my.app/pull/12/'), { owner: 'acme', pr: 12, repo: 'my.app' })
  assert.deepEqual(parseTarget('https://github.com/acme/app/issues/5'), { owner: 'acme', pr: 5, repo: 'app' })
  assert.throws(() => parseTarget('acme/app'), /not owner\/repo#123/)
})

test('resume exits 0 when the run woke', () => {
  const body = JSON.stringify({ reason: 'woke the paused run', resumed: true, state: 'paused' })
  assert.deepEqual(resumeOutcome(body), { code: 0, text: 'resumed: latest run was paused: woke the paused run' })
})

test('resume exits 1 and prints the state and the reason when the run did not wake', () => {
  const body = JSON.stringify({ reason: 'the run is running now', resumed: false, state: 'running' })
  assert.deepEqual(resumeOutcome(body), { code: 1, text: 'not resumed: latest run is running: the run is running now' })
})

test('resume exits 1 and prints none when the PR has no run', () => {
  const body = JSON.stringify({ reason: 'the PR has no run. Start a run first', resumed: false, state: null })
  assert.deepEqual(resumeOutcome(body), { code: 1, text: 'not resumed: latest run is none: the PR has no run. Start a run first' })
})

test('resume exits 1 and prints the raw text when the body has no boolean resumed', () => {
  for (const body of ['{"reason":"x","resumed":"yes","state":null}', '{"reason":"x","state":null}', 'null', 'not json'])
    assert.deepEqual(resumeOutcome(body), { code: 1, text: body })
})

test('resume prints the raw text and takes the exit code from resumed when the state or the reason is missing', () => {
  assert.deepEqual(resumeOutcome('{"resumed":true}'), { code: 0, text: '{"resumed":true}' })
  assert.deepEqual(resumeOutcome('{"resumed":false}'), { code: 1, text: '{"resumed":false}' })
  assert.deepEqual(resumeOutcome('{"reason":"x","resumed":true,"state":3}'), { code: 0, text: '{"reason":"x","resumed":true,"state":3}' })
})

test('a prune target is owner/repo or its GitHub URL', () => {
  assert.deepEqual(parseRepo('acme/app'), { owner: 'acme', repo: 'app' })
  assert.deepEqual(parseRepo('https://github.com/acme/my.app/'), { owner: 'acme', repo: 'my.app' })
  assert.deepEqual(parseRepo('https://github.com/acme/app.git'), { owner: 'acme', repo: 'app' })
  assert.throws(() => parseRepo('acme/app#7'), /not owner\/repo or a GitHub repository URL/)
})

test('prune prints each deleted, kept and failed branch, and exits 0 also with failed deletes', () => {
  const body = JSON.stringify({
    deleted: [{ name: 'factory/pr-7-1', rule: 'merged' }],
    failed: [{ name: 'factory/dev-add', reason: 'HTTP 403: protected' }],
    kept: [{ name: 'factory/pr-8-1', reason: 'open PR' }],
  })
  assert.deepEqual(pruneOutcome({ ok: true, text: body }), {
    code: 0,
    text: ['deleted factory/pr-7-1 (merged)', 'kept factory/pr-8-1: open PR', 'failed factory/dev-add: HTTP 403: protected'].join('\n'),
  })
  assert.deepEqual(pruneOutcome({ ok: true, text: '{"deleted":[],"kept":[],"failed":[]}' }), { code: 0, text: 'no factory/* branches' })
})

test('prune exits 1 and prints the raw text when the route fails or the body is not the prune result', () => {
  assert.deepEqual(pruneOutcome({ ok: false, text: 'unauthorized' }), { code: 1, text: 'unauthorized' })
  for (const text of [
    'not json',
    'null',
    '{"deleted":[],"kept":[]}',
    '{"deleted":[1],"kept":[],"failed":[]}',
    '{"deleted":[{}],"kept":[],"failed":[]}',
    '{"deleted":[{"name":"factory/a","rule":"kept"}],"kept":[],"failed":[]}',
    '{"deleted":[],"kept":[{"name":7,"reason":"open PR"}],"failed":[]}',
    '{"deleted":[],"kept":[],"failed":[{"name":"factory/a"}]}',
  ])
    assert.deepEqual(pruneOutcome({ ok: true, text }), { code: 1, text })
})

test('research posts the base, the parallel count and the budget to the research route of the issue', () => {
  const request = remoteRequest('research', 'acme/app#45', { base: 'main', budget: '12.5', parallel: '3' })
  assert.deepEqual(request, { body: '{"base":"main","parallel":3,"budget":12.5}', method: 'POST', path: '/research/acme/app/45' })
  assert.deepEqual(JSON.parse(remoteRequest('research', 'https://github.com/acme/app/issues/45', {}).body ?? ''), {})
})

test('research refuses --hotfix, --spec, --full and --ship', () => {
  for (const flag of ['hotfix', 'spec', 'full', 'ship'] as const)
    assert.throws(() => remoteRequest('research', 'acme/app#45', { [flag]: true }), { message: `research does not take --${flag}`, name: 'StopError' })
})

test('research refuses a --parallel of 0 and one that is not a number', () => {
  for (const parallel of ['0', 'two']) assert.throws(() => remoteRequest('research', 'acme/app#45', { parallel }), /--parallel must be an integer of 1 or more/)
})

test('only start, develop and research take --budget', () => {
  assert.throws(() => remoteRequest('status', 'acme/app#45', { budget: '5' }), /only start, develop and research take --budget/)
  assert.equal(JSON.parse(remoteRequest('develop', 'acme/app#45', { budget: '5' }).body ?? '').budget, 5)
  assert.equal(JSON.parse(remoteRequest('start', 'acme/app#7', { budget: '5' }).body ?? '').budget, 5)
})

test('the other commands keep their requests', () => {
  assert.deepEqual(remoteRequest('develop', 'acme/app#45', { base: 'dev', hotfix: true, parallel: '2' }), {
    body: '{"base":"dev","full":false,"hotfix":true,"spec":false,"parallel":2}',
    method: 'POST',
    path: '/develop/acme/app/45',
  })
  assert.equal(JSON.parse(remoteRequest('develop', 'acme/app#45', { spec: true }).body ?? '').spec, true)
  assert.deepEqual(remoteRequest('start', 'acme/app#7', { ship: true }), { body: '{"full":false,"ship":true}', method: 'POST', path: '/runs/acme/app/7' })
  assert.deepEqual(remoteRequest('status', 'acme/app#7', {}), { method: 'GET', path: '/runs/acme/app/7' })
  assert.deepEqual(remoteRequest('report', 'acme/app#7', {}), { method: 'GET', path: '/runs/acme/app/7/report' })
  assert.deepEqual(remoteRequest('resume', 'acme/app#7', {}), { method: 'POST', path: '/runs/acme/app/7/resume' })
  assert.deepEqual(remoteRequest('prune', 'acme/app', {}), { method: 'POST', path: '/prune/acme/app' })
  assert.throws(() => remoteRequest('toString', 'acme/app#7', {}), /unknown command toString/)
})
