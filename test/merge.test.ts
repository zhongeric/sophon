import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasConflictMarkers, mergeRefusal } from '../src/core/merge.ts'

test('mergeRefusal is stale for a 409 or a base that moved, else other', () => {
  const table: [number | undefined, string, 'stale' | 'other'][] = [
    [409, 'Head branch was modified. Review and try the merge again.', 'stale'],
    [409, 'Conflict', 'stale'],
    [405, 'Base branch was modified. Review and try the merge again.', 'stale'],
    [405, 'Head branch is out of date. Review and try the merge again.', 'stale'],
    [undefined, 'The head branch is not up to date with the base branch', 'stale'],
    [undefined, 'This branch is behind the base branch', 'stale'],
    [405, 'Pull Request is not mergeable', 'other'],
    [405, 'Pull Request is still a draft', 'other'],
    [405, 'Changes must be made through the merge queue', 'other'],
    [405, 'At least 1 approving review is required by reviewers with write access.', 'other'],
    [undefined, 'socket hang up', 'other'],
  ]
  for (const [status, message, kind] of table) assert.equal(mergeRefusal(status, message), kind, `${status} ${message}`)
})

test('hasConflictMarkers finds each marker line, and not a similar line', () => {
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> main\n'), true)
  assert.equal(hasConflictMarkers('<<<<<<< HEAD'), true)
  assert.equal(hasConflictMarkers('a\r\n=======\r\nb'), true)
  assert.equal(hasConflictMarkers('x\n>>>>>>> 1a2b3c'), true)
  assert.equal(hasConflictMarkers('const a = 1\n'), false)
  assert.equal(hasConflictMarkers('<<<<<<<HEAD\n======== \n ======= \n>>>>>>>\n'), false)
  assert.equal(hasConflictMarkers(''), false)
})
