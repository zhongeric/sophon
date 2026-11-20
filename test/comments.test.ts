import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderStatus, type StatusView } from '../src/cloudflare/status.ts'
import { renderPlan } from '../src/core/plan.ts'
import { commentLimit, render, type Answer, type Question } from '../src/core/questions.ts'
import { defaultModels } from '../src/core/workflows/code-review-loop.ts'
import { cutReport, defaultDevelopModels, prBody, type DevelopInput } from '../src/core/workflows/develop.ts'
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

test('the PR body keeps the line breaks of a long smallest change that it cuts', () => {
  const paragraph = Array.from({ length: 100 }, (_, index) => `word${index}`).join(' ')
  const smallest = `${paragraph}\n\n- first item\n- second item\n\n${paragraph}`
  const shown = visible(prBody(input, [], '# Plan', smallest)).trim()
  assert.match(shown, /^word0 [\s\S]* word99\n\n- first item\n- second item\n\nword0 [\s\S]* …$/)
  assert.equal(shown.split(/\s+/).length, 141)
})

test('the PR body closes a code fence at the cutoff before the details block', () => {
  for (const fence of ['```', '~~~', '````', '~~~~~']) {
    const start = `Add this example.\n\n- First item\n- Second item\n\n   ${fence}text\n${fence.slice(1)}\n${fence}not-a-close\n`
    const smallest = `${start}${'word '.repeat(200)}\n${fence}`
    const text = body(smallest, 12)
    const shown = text.slice(0, text.indexOf('<details>'))
    assert.ok(shown.startsWith(`Closes #12\n\n${start}`))
    // Check the fence directly because visible() does not parse Markdown code blocks.
    assert.ok(shown.endsWith(` …\n${fence}\n\n`), shown)
    assert.ok(visibleWords(text) <= 150)
    assert.ok(details(text).includes(smallest))
  }
})

test('the PR body keeps complete code fences unchanged', () => {
  const smallest = 'Add this example.\n\n```text\nexample\n```\n\n~~~text\nexample\n~~~~\n\nKeep this paragraph.'
  assert.equal(visible(body(smallest)).trim(), smallest)
})

test('a cut report closes its open details block, so that the cut note stays visible', () => {
  const report = `# Development run: READY\n\n<details><summary>Run details</summary>\n\n${'x'.repeat(commentLimit)}\n\n</details>`
  const cut = cutReport(report, '(cut: see report.md)')
  assert.ok(cut.endsWith('</details>\n\n(cut: see report.md)'))
  assert.equal(visible(cut).trim(), '# Development run: READY\n\n\n\n(cut: see report.md)')
  assert.equal(cutReport('short', '(cut)'), 'short')
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

test('the status comment has the marker, the run, its state and one line about how to answer', () => {
  const view = (kind: StatusView['kind'], run: string): StatusView => ({ by: 'maintainer', kind, notice: null, run, shown: { state: 'running' }, step: null, target: 'acme/app#5' })
  for (const [kind, run] of [['development', 'dev-5-1'], ['review', 'pr-7-1'], ['research', 'research-9-1']] as const) {
    const text = renderStatus(view(kind, run))
    assert.equal(text.split('\n')[0], `<!-- agent-factory:status run=${run} -->`)
    assert.doesNotMatch(text, /@/)
    assert.deepEqual(visibleLines(text), [`**agent-factory** ${kind} run \`${run}\` for \`maintainer\``, '**State:** running.', 'Questions come as new comments. Answer them with a `/answer` comment.'])
  }
})

test('the status comment collapses a result without a result comment, and links to a result comment', () => {
  const base: StatusView = { by: 'maintainer', kind: 'development', notice: null, run: 'dev-5-1', shown: { state: 'running' }, step: null, target: 'acme/app#5' }
  const inline = renderStatus({ ...base, shown: { comment: null, passed: true, state: 'ended', summary: '# Development run: READY' } })
  assert.ok(visibleLines(inline).includes('**Result:** passed.'))
  assert.match(inline, /<details><summary>Result<\/summary>\n\n# Development run: READY\n\n<\/details>/)
  const linked = renderStatus({ ...base, shown: { comment: 'https://github.com/acme/app/issues/5#issuecomment-9', passed: false, state: 'ended', summary: '' } })
  assert.ok(visibleLines(linked).includes('**Result:** failed. See the [result comment](https://github.com/acme/app/issues/5#issuecomment-9).'))
  assert.doesNotMatch(linked, /<details>/)
})
