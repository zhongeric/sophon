import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkIntake, checkPlan, checkSpec, frozenAsk, parseParallel, route, routeQuestions, waves, type Plan, type PlanTask } from '../src/core/plan.ts'

const intake = { title: 'Add sub', summary: 'Adds sub() to src/math.ts.', slug: 'add-sub', larger: false, passes: 1, reason: 'One small function.', questions: [] }
const answer = (id: string, text: string) => ({ id, question: id, answer: text, recommended: false })

test('the intake needs a title, a branch slug, and the route with its reason', () => {
  assert.throws(() => checkIntake({ ...intake, slug: 'Add Sub', passes: 3, reason: '' }), /slug must be .*\npasses must be 1 or 2\nreason is required/)
  assert.deepEqual(checkIntake(intake).questions, [])
})

test('the host asks to confirm the ask and the route in the same batch, and reads the route from the answers', () => {
  const question = { question: 'May sub return a negative number?', why: 'sub(3, 5)', options: ['Yes', 'No, throw'], recommendation: 'Yes' }
  const asked = checkIntake({ ...intake, larger: true, questions: [question] })
  assert.deepEqual(
    routeQuestions(asked).map((entry) => [entry.id, entry.recommendation]),
    [
      ['Q2', 'Yes, go on'],
      ['Q3', 'Write a spec first'],
      ['Q4', 'One pass'],
    ],
  )
  assert.deepEqual(route(asked, []), { stop: false, spec: true, passes: 1 })
  assert.deepEqual(route(asked, [answer('Q2', 'Yes, and also handle zero'), answer('Q3', 'Plan now'), answer('Q4', 'Two passes')]), { stop: false, spec: false, passes: 2 })
  assert.equal(route(asked, [answer('Q2', 'No, stop the run')]).stop, true)
  for (const text of ['no', 'Stop.', 'No, stop', 'no stop the run!', 'Stop the run', 'Stop the run!', ' STOP THE RUN. '])
    assert.equal(route(asked, [answer('Q2', text)]).stop, true, text)
  // A correction that starts with "No" goes on, as a decision for the planner.
  for (const text of ['No, it must also handle zero', 'No — only the CLI, not the API', 'Nothing to add', 'stop at the first error'])
    assert.equal(route(asked, [answer('Q2', text)]).stop, false, text)
})

test('the builder count is an integer of 1 or more', () => {
  assert.equal(parseParallel('2'), 2)
  for (const text of ['abc', '3x', '0', '-1', '1.5', '']) assert.throws(() => parseParallel(text), /--parallel must be an integer of 1 or more/, text)
})

test('the spec needs its sections as headings', () => {
  assert.throws(() => checkSpec({ spec: '# Summary\nx\n## Surfaces\ny', decisions: [] }), /Edge cases, Out of scope, Decisions/)
  const spec = ['# Summary', '## Surfaces', '## Edge cases', '## Out of scope', '## Decisions'].join('\ntext\n')
  assert.equal(checkSpec({ spec, decisions: [] }).spec, spec)
})

const task = (id: string, files: string[], depends_on: string[] = []): PlanTask => ({ id, title: id, work: `Build ${id}.`, files, depends_on })
const plan: Plan = {
  smallest_change: 'Add sub.',
  goals: ['sub subtracts'],
  non_goals: ['No division'],
  done: [{ check: 'The tests pass', command: 'npm test' }],
  sections: [],
  tasks: [task('sub', ['src/sub.ts'])],
}

test('the host refuses a plan without its four parts, a check with a command, or the sections of its profiles', () => {
  assert.throws(
    () => checkPlan({ ...plan, non_goals: [], done: [{ check: 'It looks right', command: '' }] }, ['Interfaces']),
    (error: Error) => ['non_goals is empty', 'done needs at least one check with a command', 'the section "Interfaces"'].every((part) => error.message.includes(part)),
  )
  assert.equal(checkPlan({ ...plan, sections: [{ name: 'interfaces', text: 'No interface changes.' }] }, ['Interfaces']).tasks.length, 1)
})

test('the host refuses tasks that it cannot schedule', () => {
  assert.throws(() => checkPlan({ ...plan, tasks: [task('sub', ['src/sub.ts'], ['mul']), task('Mul', ['../x'])] }, []), (error: Error) =>
    ['depends on the unknown task "mul"', 'task "Mul": the ID must be', '"../x" must be relative'].every((part) => error.message.includes(part)),
  )
  assert.throws(() => checkPlan({ ...plan, tasks: [task('a', ['a'], ['b']), task('b', ['b'], ['a'])] }, []), /cycle/)
  assert.throws(() => checkPlan({ ...plan, tasks: [] }, []), /give 1 to 8 tasks/)
})

test('a wave holds ready tasks whose files do not overlap, up to the limit', () => {
  const tasks = [task('a', ['src/a.ts']), task('b', ['src/b/']), task('c', ['src/b/c.ts']), task('d', ['test/'], ['a', 'b']), task('e', ['docs'])]
  const ids = (limit: number) => waves(tasks, limit).map((wave) => wave.map((entry) => entry.id))
  assert.deepEqual(ids(3), [
    ['a', 'b', 'e'],
    ['c', 'd'],
  ])
  assert.deepEqual(ids(1), [['a'], ['b'], ['c'], ['d'], ['e']])
})

test('the frozen package holds the verbatim ask, the decisions and the plan, but not the tasks', () => {
  const frozen = frozenAsk('Add sub.', [{ id: 'Q1', question: 'Negative results?', answer: 'Allow them', recommended: true }], plan)
  assert.match(frozen, /^Add sub\.\n\n## Decisions of the user\n\n- Negative results\? \*\*Allow them\*\*\n\n# Plan\n\n## Smallest change/)
  assert.match(frozen, /- \[ \] The tests pass \(`npm test`\)/)
  assert.doesNotMatch(frozen, /## Tasks/)
})
