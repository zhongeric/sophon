import assert from 'node:assert/strict'
import { test } from 'node:test'
import { developAnnouncement, reviewAnnouncement } from '../src/cloudflare/announcements.ts'
import { renderPlan } from '../src/core/plan.ts'
import { render, type Answer, type Question } from '../src/core/questions.ts'
import { defaultModels } from '../src/core/workflows/code-review-loop.ts'
import { defaultDevelopModels, prBody, type DevelopInput } from '../src/core/workflows/develop.ts'
import { plan } from './support/develop.ts'
import { visible, visibleLines, visibleWords } from './support/visible.ts'

const input: DevelopInput = {
  ask: 'Add sub and mul next to add, with tests.\nKeep add as it is.',
  base: 'abc',
  baseRef: 'main',
  config: { stack: 'TypeScript', checks: {} },
  models: { develop: defaultDevelopModels, review: defaultModels },
  runId: 'dev-1',
  source: 'acme/app#12',
}
const answers: Answer[] = [
  { id: 'Q1', question: 'Add div too?', answer: 'No, only sub and mul', recommended: true },
  { id: 'Q2', question: 'Write a spec before the plan?', answer: 'Plan now', recommended: true, decidedBy: 'run' },
]
const body = (smallest: string, issue?: number) =>
  prBody({ ...input, ...(issue ? { issue } : {}) }, answers, `# Plan\n\n${renderPlan({ ...plan, smallest_change: smallest }, { tasks: true })}`, smallest)
const details = (text: string) => /<details><summary>[^\n]*<\/summary>\n\n([\s\S]*)\n\n<\/details>$/.exec(text)?.[1] ?? ''

test('the PR body shows Closes and the smallest change, and collapses the run, the ask, the decisions and the plan', () => {
  const text = body(plan.smallest_change, 12)
  assert.equal(visible(text).trim(), `Closes #12\n\n${plan.smallest_change}`)
  assert.ok(text.startsWith('Closes #12\n'))
  const inside = details(text)
  assert.match(inside, /^agent-factory run `dev-1` \(acme\/app#12\) opened this draft PR\./)
  assert.match(inside, /# Ask\n\n> Add sub and mul next to add, with tests\.\n> Keep add as it is\./)
  assert.match(inside, /# Decisions of the user\n\n- Add div too\? \*\*No, only sub and mul\*\*/)
  assert.match(inside, /# Decisions the run made\n\n- Write a spec before the plan\? \*\*Plan now\*\*/)
  assert.match(inside, /# Plan\n\n## Smallest change[\s\S]*## Non-goals\n\n- No division[\s\S]*## Tasks/)
  assert.ok(visibleWords(text) <= 150)
})

test('the PR body cuts a long smallest change and keeps the full plan in the collapsed block', () => {
  const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ')
  const text = body(long, 12)
  assert.ok(visibleWords(text) <= 150, String(visibleWords(text)))
  assert.match(visible(text), /^Closes #12\n\nword0 word1 [\s\S]* …\n/)
  assert.ok(details(text).includes(long))
})

test('the PR body without an issue has no Closes line', () => {
  const text = body(plan.smallest_change)
  assert.doesNotMatch(text, /Closes/)
  assert.equal(visible(text).trim(), plan.smallest_change)
})

test('the question comment has the marker, one line about how to answer, then every question', () => {
  const questions: Question[] = [
    { id: 'Q1', question: 'Which way?', why: 'It changes the API.', options: ['up', 'down'], recommendation: 'up', level: 'user', rule: 'decision' },
    { id: 'Q2', question: 'Ship now?', why: 'It changes the budget.', options: ['yes', 'no'], recommendation: 'yes', level: 'user', rule: 'spend' },
  ]
  const text = render('run-1', 'ask', questions)
  assert.equal(text.split('\n')[0], '<!-- agent-factory:questions run=run-1 batch=ask -->')
  const lines = visibleLines(text)
  const first = lines.indexOf('**Q1.** Which way?')
  assert.equal(first, 1)
  assert.match(lines[0]!, /`\/answer` comment.*`Q<n>: <letter or your own words>`.*recommendation.*`\/answer recommended`/)
  assert.ok(lines.includes('**Q2.** Ship now?'))
  assert.ok(lines.includes('- a) up (recommended)') && lines.includes('- b) no'))
})

test('each start comment is one line', () => {
  for (const text of [developAnnouncement('dev-5-1', 'maintainer'), reviewAnnouncement('pr-7-1', 'maintainer')]) {
    assert.doesNotMatch(text, /\n/)
    assert.match(text, /^agent-factory started (development|review) run `(dev-5-1|pr-7-1)` for @maintainer\. .*`\/answer`/)
  }
})
