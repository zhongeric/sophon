import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRepo, parseTarget, pruneOutcome, resumeOutcome } from '../src/node/remote.ts'

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
  for (const text of ['not json', 'null', '{"deleted":[],"kept":[]}', '{"deleted":[1],"kept":[],"failed":[]}'])
    assert.deepEqual(pruneOutcome({ ok: true, text }), { code: 1, text })
})
