import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryFileSystem } from 'nanocode-ts/bash'
import { targetedTests, type RepoConfig } from '../src/core/checks.ts'
import { baseTargetedTests } from '../src/core/develop-steps.ts'
import { checkIntake, checkPlan, checkSpec, frozenAsk, parseIssue, parseParallel, route, routeQuestions, waves, type Plan, type PlanTask } from '../src/core/plan.ts'

const intake = { title: 'Add sub', summary: 'Adds sub() to src/math.ts.', slug: 'add-sub', larger: false, passes: 1, reason: 'One small function.', questions: [] }
const answer = (id: string, text: string) => ({ id, question: id, answer: text, recommended: false })

test('the intake needs a title, a branch slug, and the route with its reason', () => {
  assert.throws(() => checkIntake({ ...intake, slug: 'Add Sub', passes: 3, reason: '' }), /slug must be .*\npasses must be 1 or 2\nreason is required/)
  assert.deepEqual(checkIntake(intake).questions, [])
})

test('the route questions are run questions after the intake questions, and the host reads the route from the answers', () => {
  assert.deepEqual(
    routeQuestions(checkIntake(intake)).map((entry) => [entry.id, entry.recommendation, entry.level]),
    [
      ['Q1', 'Yes, go on', 'run'],
      ['Q2', 'Plan now', 'run'],
      ['Q3', 'One pass', 'run'],
    ],
  )
  // A user question of the intake agent posts the batch, so the confirmation goes to the user with the summary.
  const question = { question: 'May sub return a negative number?', why: 'sub(3, 5)', options: ['Yes', 'No, throw'], recommendation: 'Yes', level: 'user', rule: 'scope' }
  const asked = checkIntake({ ...intake, larger: true, questions: [question] })
  assert.equal(routeQuestions(asked)[0]!.rule, 'scope')
  assert.deepEqual(
    routeQuestions(asked).map((entry) => [entry.id, entry.recommendation, entry.level]),
    [
      ['Q2', 'Yes, go on', 'user'],
      ['Q3', 'Write a spec first', 'run'],
      ['Q4', 'One pass', 'run'],
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

test('the issue of a local run is a number of 1 or more', () => {
  assert.equal(parseIssue('12'), 12)
  for (const text of ['0', '-1', '1.5', 'abc', '']) assert.throws(() => parseIssue(text), /--issue must be an issue number of 1 or more, not /, text)
})

test('the spec needs its sections as headings', () => {
  assert.throws(() => checkSpec({ spec: '# Summary\nx\n## Surfaces\ny', decisions: [] }), /Edge cases, Out of scope, Decisions/)
  const spec = ['# Summary', '## Surfaces', '## Edge cases', '## Out of scope', '## Decisions'].join('\ntext\n')
  assert.equal(checkSpec({ spec, decisions: [] }).spec, spec)
})

const task = (id: string, files: string[], depends_on: string[] = []): PlanTask => ({ id, title: id, work: `Build ${id}.`, files, depends_on })
const unprotected = () => false
const noTests = async () => []
const plan: Plan = {
  smallest_change: 'Add sub.',
  goals: ['sub subtracts'],
  non_goals: ['No division'],
  done: [{ check: 'The tests pass', command: 'npm test' }],
  sections: [],
  tasks: [task('sub', ['src/sub.ts'])],
}

test('the host refuses a plan without its four parts, a check with a command, or the sections of its profiles', async () => {
  await assert.rejects(
    checkPlan({ ...plan, non_goals: [], done: [{ check: 'It looks right', command: '' }] }, ['Interfaces'], unprotected, noTests),
    (error: Error) => ['non_goals is empty', 'done needs at least one check with a command', 'the section "Interfaces"'].every((part) => error.message.includes(part)),
  )
  assert.equal((await checkPlan({ ...plan, sections: [{ name: 'interfaces', text: 'No interface changes.' }] }, ['Interfaces'], unprotected, noTests)).tasks.length, 1)
})

test('the host refuses tasks that it cannot schedule', async () => {
  await assert.rejects(checkPlan({ ...plan, tasks: [task('sub', ['src/sub.ts'], ['mul']), task('Mul', ['../x'])] }, [], unprotected, noTests), (error: Error) =>
    ['depends on the unknown task "mul"', 'task "Mul": the ID must be', '"../x" must be relative'].every((part) => error.message.includes(part)),
  )
  await assert.rejects(checkPlan({ ...plan, tasks: [task('a', ['a'], ['b']), task('b', ['b'], ['a'])] }, [], unprotected, noTests), /cycle/)
  await assert.rejects(checkPlan({ ...plan, tasks: [] }, [], unprotected, noTests), /give 1 to 8 tasks/)
})

test('the host refuses a task whose files include a protected path, with one error for each such file', async () => {
  const isProtected = (path: string) => ['wrangler.jsonc', '.github/'].includes(path)
  const deploy = task('deploy', ['src/deploy.ts', 'wrangler.jsonc', '.github/'])
  await assert.rejects(
    checkPlan({ ...plan, tasks: [deploy] }, [], isProtected, noTests),
    (error: Error) =>
      error.message ===
      ['task "deploy": "wrangler.jsonc" is a protected path, and the host refuses each write to it', 'task "deploy": ".github/" is a protected path, and the host refuses each write to it'].join('\n'),
  )
  assert.equal((await checkPlan({ ...plan, tasks: [{ ...deploy, files: ['src/deploy.ts'] }] }, [], isProtected, noTests)).tasks.length, 1)
})

test('the host refuses a plan that puts a targeted test of a task in another task, as in #107', async () => {
  const files = {
    'src/core/profiles.ts': 'export const profiles = []\n',
    'test/loop.test.ts': "import { test } from 'node:test'\nimport { profiles } from '../src/core/profiles.ts'\n\ntest('loop', () => {})\n",
  }
  const repo = {
    tree: MemoryFileSystem.create({ files: Object.fromEntries(Object.entries(files).map(([path, content]) => [`/${path}`, content])) }),
    committedFiles: async () => Object.keys(files),
  }
  const config: RepoConfig = { stack: 'TypeScript', checks: {}, tests: { pattern: '^test/[^/]+\\.test\\.ts$', command: 'node --test {tests}' } }
  const targeted = (changed: string[]) => targetedTests(repo, config, changed)
  await assert.rejects(
    checkPlan({ ...plan, tasks: [task('triage', ['src/core/profiles.ts']), task('loop', ['test/loop.test.ts'])] }, [], unprotected, targeted),
    (error: Error) => error.message === 'task "triage": its targeted test test/loop.test.ts is in task "loop". Put them in one task.',
  )
  assert.equal((await checkPlan({ ...plan, tasks: [task('triage', ['src/core/profiles.ts', 'test/loop.test.ts'])] }, [], unprotected, targeted)).tasks.length, 1)
  // A test in the files of both tasks is not refused.
  assert.equal((await checkPlan({ ...plan, tasks: [task('triage', ['src/core/profiles.ts', 'test/loop.test.ts']), task('loop', ['test/loop.test.ts'])] }, [], unprotected, targeted)).tasks.length, 2)
})

test('the targeted tests of a task on the base tree expand directories, keep new files and skip empty base names', async () => {
  const files = {
    '.gitignore': 'node_modules\n',
    'src/core/profiles.ts': 'export const profiles = []\n',
    'test/loop.test.ts': "import { profiles } from '../src/core/profiles.ts'\n",
    'test/widget.test.ts': "import { widget } from '../src/widget.ts'\n",
  }
  const tree = MemoryFileSystem.create({ files: Object.fromEntries(Object.entries(files).map(([path, content]) => [`/${path}`, content])) })
  const config: RepoConfig = { stack: 'TypeScript', checks: {}, tests: { pattern: '^test/[^/]+\\.test\\.ts$', command: 'node --test {tests}' } }
  const targeted = baseTargetedTests(config, tree)
  assert.deepEqual(await targeted(['src/core']), ['test/loop.test.ts'])
  assert.deepEqual(await targeted(['src/']), ['test/loop.test.ts'])
  assert.deepEqual(await targeted(['src/widget.ts']), ['test/widget.test.ts'])
  assert.deepEqual(await targeted(['src/empty/']), [])
  assert.deepEqual(await targeted(['.gitignore', '.nvmrc']), [])
  const tasks = [task('config', ['.gitignore', '.nvmrc']), task('feature', ['src/widget.ts', 'test/widget.test.ts'])]
  assert.equal((await checkPlan({ ...plan, tasks }, [], unprotected, targeted)).tasks.length, 2)
})

test('a failed listing of the base tree is not kept for the next plan submit', async () => {
  const tree = MemoryFileSystem.create({ files: { '/src/math.ts': 'export const add = 1\n', '/test/math.test.ts': "import { add } from '../src/math.ts'\n" } })
  let failures = 1
  const flaky = {
    stat: tree.stat.bind(tree),
    lstat: tree.lstat?.bind(tree),
    readlink: tree.readlink?.bind(tree),
    read: tree.read.bind(tree),
    write: tree.write.bind(tree),
    mkdir: tree.mkdir.bind(tree),
    remove: tree.remove.bind(tree),
    rename: tree.rename.bind(tree),
    list: async (path: string) => {
      if (failures-- > 0) throw new Error('transient read error')
      return tree.list(path)
    },
  }
  const config: RepoConfig = { stack: 'TypeScript', checks: {}, tests: { pattern: '^test/[^/]+\\.test\\.ts$', command: 'node --test {tests}' } }
  const targeted = baseTargetedTests(config, flaky)
  await assert.rejects(targeted(['src/math.ts']), /transient read error/)
  assert.deepEqual(await targeted(['src/math.ts']), ['test/math.test.ts'])
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
  assert.doesNotMatch(frozen, /## Decisions the run made/)
})

test('the frozen package lists the decisions of the user and the decisions that the run made, each with its label', () => {
  const frozen = frozenAsk(
    'Add sub.',
    [
      { id: 'Q1', question: 'Negative results?', answer: 'Allow them', recommended: true },
      { id: 'Q2', question: 'How many review loop passes?', answer: 'One pass', recommended: true, decidedBy: 'run' },
    ],
    plan,
  )
  assert.match(frozen, /## Decisions of the user\n\n- Negative results\? \*\*Allow them\*\*\n\n## Decisions the run made\n\n- How many review loop passes\? \*\*One pass\*\*\n\n# Plan/)
  const runOnly = frozenAsk('Add sub.', [{ id: 'Q1', question: 'Spec?', answer: 'Plan now', recommended: true, decidedBy: 'run' }], plan)
  assert.match(runOnly, /^Add sub\.\n\n## Decisions the run made\n\n- Spec\? \*\*Plan now\*\*/)
})
