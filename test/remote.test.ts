import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget } from '../src/node/remote.ts'

test('a PR is owner/repo#number or its GitHub URL', () => {
  assert.deepEqual(parseTarget('acme/app#7'), { owner: 'acme', pr: 7, repo: 'app' })
  assert.deepEqual(parseTarget('https://github.com/acme/my.app/pull/12/'), { owner: 'acme', pr: 12, repo: 'my.app' })
  assert.throws(() => parseTarget('acme/app'), /not owner\/repo#123/)
})
