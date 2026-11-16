import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** The README is for users. Design detail goes to docs/specs, so the README stays short (AGENTS.md, Writing). */
const readmeMaxLines = 200

test('README.md stays within its line budget', () => {
  const lines = readFileSync(new URL('../README.md', import.meta.url), 'utf8').trimEnd().split('\n').length
  assert.ok(lines <= readmeMaxLines, `README.md has ${lines} lines, over the budget of ${readmeMaxLines}. Cut text, or move design detail to docs/specs/.`)
})
