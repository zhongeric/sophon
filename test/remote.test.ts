import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget, resumeOutcome } from '../src/node/remote.ts'

test('a PR is owner/repo#number or its GitHub URL', () => {
  assert.deepEqual(parseTarget('acme/app#7'), { owner: 'acme', pr: 7, repo: 'app' })
  assert.deepEqual(parseTarget('https://github.com/acme/my.app/pull/12/'), { owner: 'acme', pr: 12, repo: 'my.app' })
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
