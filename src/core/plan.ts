import type { Contracts } from 'nanocode-ts'
import { checkQuestions, decisionLists, questionsSchema, type Answer, type Question } from './questions.ts'
import { StopError } from './stop.ts'

/** What the intake turn of the planner session understood of the ask, and the review passes that it recommends (D19). */
export type Intake = {
  title: string
  summary: string
  slug: string
  passes: 1 | 2
  reason: string
  questions: Question[]
}

export const submitIntake: Contracts.HostTool = {
  name: 'submit_intake',
  description:
    'Submit the intake one time: your summary of the ask, a PR title, a branch slug, the route (review passes) with the reason, and your open questions, each with a level by D11.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short PR title in the imperative, at most 72 characters' },
      summary: { type: 'string', description: 'The ask as you understand it, with the parts of the repository that it touches' },
      slug: { type: 'string', description: 'Lowercase words joined with hyphens, at most 40 characters, for example add-fee-switch' },
      passes: { type: 'integer', enum: [1, 2], description: 'Review loop passes: 2 for a larger feature set in Solidity src/, else 1' },
      reason: { type: 'string', description: 'Why you chose passes, in one or two sentences' },
      questions: questionsSchema,
    },
    required: ['title', 'summary', 'slug', 'passes', 'reason', 'questions'],
    additionalProperties: false,
  },
}

export function checkIntake(input: unknown): Intake {
  const intake = input as Intake
  const problems = [
    ...(!intake?.title?.trim() || intake.title.length > 72 ? ['title must have 1 to 72 characters'] : []),
    ...(!intake?.summary?.trim() ? ['summary is required'] : []),
    ...(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(intake?.slug ?? '') || intake.slug.length > 40 ? ['slug must be lowercase words joined with hyphens, at most 40 characters'] : []),
    ...(intake?.passes !== 1 && intake?.passes !== 2 ? ['passes must be 1 or 2'] : []),
    ...(!intake?.reason?.trim() ? ['reason is required'] : []),
  ]
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { ...intake, questions: checkQuestions({ questions: intake.questions }) }
}

export const confirmOptions = ['Yes, go on', 'No, stop the run']
export const passOptions = ['One pass', 'Two passes']

/**
 * The host's questions after the intake turn's: confirm the ask, then the review passes (P4). They are run questions (D11), so
 * the host takes the recommendation of the intake turn. When the intake turn raises a user question, the batch goes to the user
 * anyway, so the confirmation goes too, with rule scope: the user sees the summary and can correct it or stop the run.
 * One batch, so a user question of the intake turn needs one round trip.
 */
export function routeQuestions(intake: Intake): Question[] {
  const next = (offset: number) => `Q${intake.questions.length + offset}`
  const confirm: Pick<Question, 'level' | 'rule'> = intake.questions.some((question) => question.level === 'user') ? { level: 'user', rule: 'scope' } : { level: 'run' }
  return [
    { id: next(1), question: 'Is this the ask? Correct it in your own words if it is not.', why: intake.summary, options: confirmOptions, recommendation: confirmOptions[0]!, ...confirm },
    { id: next(2), question: 'How many review loop passes?', why: intake.reason, options: passOptions, recommendation: passOptions[intake.passes - 1]!, level: 'run' },
  ]
}

export type Route = { stop: boolean; spec: boolean; passes: 1 | 2 }

/** The spec route question of a ledger from before D19, and its option for a spec. */
const oldSpecQuestion = 'Write a spec before the plan?'
const oldSpecOption = 'Write a spec first'

/**
 * Reads the route from the answers to the host's questions. Free text that corrects the ask becomes a decision for the planner.
 * A correction can start with "No,". The stop option, "no", "stop", and "stop the run" stop the run.
 * `spec` is the spec option of the run, false by default. A batch from before D19 has the spec route question, with other question IDs, so the
 * host reads each answer by its question text first, and the old spec answer also gives a spec (D19). Research changes the
 * text of the confirm question, so the ID is the fallback, but not in a batch from before D19.
 */
export function route(intake: Intake, answers: Answer[], spec = false): Route {
  const byText = (question: string) => answers.find((answer) => answer.question === question)?.answer
  const oldSpec = byText(oldSpecQuestion)
  const byId = (id: string) => (oldSpec === undefined ? answers.find((answer) => answer.id === id)?.answer : undefined)
  const [confirm, passes] = routeQuestions(intake).map((question) => byText(question.question) ?? byId(question.id) ?? question.recommendation)
  return {
    stop: confirm === confirmOptions[1] || /^\s*(no([\s,]+stop(\s+the\s+run)?)?|stop(\s+the\s+run)?)[.!]?\s*$/i.test(confirm!),
    spec: spec || (oldSpec !== undefined && (oldSpec === oldSpecOption || /^\s*(yes|spec)\b/i.test(oldSpec))),
    passes: passes === passOptions[1] || /\b(two|2)\b/i.test(passes!) ? 2 : 1,
  }
}

export type Spec = { spec: string; decisions: Question[] }

export const specSections = ['Summary', 'Surfaces', 'Edge cases', 'Out of scope', 'Decisions']

export const submitSpec: Contracts.HostTool = {
  name: 'submit_spec',
  description: `Submit the spec one time, in Markdown with the sections ${specSections.join(', ')}. Also submit each decision as a question with options, your recommendation and a level by D11. Only a user question goes to the user.`,
  parameters: {
    type: 'object',
    properties: { spec: { type: 'string', description: 'The spec in Markdown' }, decisions: questionsSchema },
    required: ['spec', 'decisions'],
    additionalProperties: false,
  },
}

const hasSection = (markdown: string, name: string) => new RegExp(`^#+\\s*${name}\\s*$`, 'im').test(markdown)

export function checkSpec(input: unknown): Spec {
  const spec = input as Spec
  const missing = specSections.filter((name) => !hasSection(spec?.spec ?? '', name))
  if (missing.length > 0) throw new Error(`the spec needs these sections as Markdown headings: ${missing.join(', ')}`)
  return { spec: spec.spec, decisions: checkQuestions({ questions: spec.decisions }) }
}

/** One builder's work. `files` is its write scope: files or directories, relative to the repository root. */
export type PlanTask = { id: string; title: string; work: string; files: string[]; depends_on: string[] }

export type Plan = {
  smallest_change: string
  goals: string[]
  non_goals: string[]
  /** Acceptance checks. A check with a command is a command that shows it, else a statement that a reviewer verifies. */
  done: { check: string; command: string }[]
  sections: { name: string; text: string }[]
  tasks: PlanTask[]
}

export const maxTasks = 8

const strings = { type: 'array', items: { type: 'string' } }

export const submitPlan: Contracts.HostTool = {
  name: 'submit_plan',
  description:
    'Submit the plan one time: the four parts (smallest change, goals, non-goals, done checks), the sections that /review/plan-sections.txt names, and the tasks for the builders. ' +
    'The host refuses a plan with an empty part, with no done check that has a command, or with tasks that depend on unknown tasks or on each other in a cycle. ' +
    'It also refuses a task whose files include a protected path, because the host refuses each write to it. The prompt lists the protected paths. ' +
    'It also refuses a task when a targeted test of its files is only in the files of another task, because the task cannot change that test.',
  parameters: {
    type: 'object',
    properties: {
      smallest_change: { type: 'string' },
      goals: strings,
      non_goals: strings,
      done: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            check: { type: 'string', description: 'What must be true' },
            command: { type: 'string', description: 'A command that shows it, for example npm test -- test/fee.test.ts, or an empty string for a statement' },
          },
          required: ['check', 'command'],
          additionalProperties: false,
        },
      },
      sections: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'], additionalProperties: false },
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lowercase letters, digits and hyphens, for example fee-math' },
            title: { type: 'string' },
            work: { type: 'string', description: 'What to build, the constraints, and the done checks that the task covers' },
            files: { ...strings, description: 'The files and directories that the builder may write, relative to the repository root' },
            depends_on: { ...strings, description: 'IDs of the tasks that must finish first' },
          },
          required: ['id', 'title', 'work', 'files', 'depends_on'],
          additionalProperties: false,
        },
      },
    },
    required: ['smallest_change', 'goals', 'non_goals', 'done', 'sections', 'tasks'],
    additionalProperties: false,
  },
}

/**
 * Refuses a plan without its four parts, its required sections, or tasks that the host can schedule.
 * `isProtected` tells which task files the host refuses to write, so a task with one of them can never finish.
 * `targeted` gives the targeted tests of the files of a task on the base tree. A task whose targeted test is only in
 * the files of another task cannot fix that test, so its builder blocks.
 */
export async function checkPlan(input: unknown, sections: string[], isProtected: (path: string) => boolean, targeted: (files: string[]) => Promise<string[]>): Promise<Plan> {
  const plan = input as Plan
  const filled = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === 'string' && item.trim() !== '')
  const problems: string[] = []
  if (!plan?.smallest_change?.trim()) problems.push('smallest_change is empty')
  if (!filled(plan?.goals)) problems.push('goals is empty')
  if (!filled(plan?.non_goals)) problems.push('non_goals is empty')
  if (!Array.isArray(plan?.done) || !plan.done.some((item) => item?.check?.trim() && item.command?.trim())) problems.push('done needs at least one check with a command')
  for (const name of sections)
    if (!plan?.sections?.some((section) => section.name.trim().toLowerCase() === name.toLowerCase() && section.text.trim())) problems.push(`the plan needs the section "${name}"`)
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  if (tasks.length === 0 || tasks.length > maxTasks) problems.push(`give 1 to ${maxTasks} tasks`)
  const ids = tasks.map((task) => task?.id)
  for (const task of tasks) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task?.id ?? '') || task.id.length > 30) problems.push(`task "${task?.id}": the ID must be lowercase words joined with hyphens, at most 30 characters`)
    if (ids.indexOf(task.id) !== ids.lastIndexOf(task.id)) problems.push(`task "${task.id}": the ID is not unique`)
    if (!task.title?.trim() || !task.work?.trim()) problems.push(`task "${task.id}": title and work are required`)
    if (!filled(task.files)) problems.push(`task "${task.id}": files is empty`)
    else
      for (const path of task.files)
        if (/^\/|(^|\/)\.\.(\/|$)/.test(path)) problems.push(`task "${task.id}": "${path}" must be relative to the repository root, without ..`)
        else if (isProtected(path)) problems.push(`task "${task.id}": "${path}" is a protected path, and the host refuses each write to it`)
    if (!Array.isArray(task.depends_on)) problems.push(`task "${task.id}": depends_on must be a list`)
    else for (const id of task.depends_on) if (!ids.includes(id)) problems.push(`task "${task.id}": depends on the unknown task "${id}"`)
  }
  if (problems.length === 0 && waves(tasks, maxTasks).flat().length < tasks.length) problems.push('the tasks depend on each other in a cycle')
  if (problems.length === 0)
    for (const task of tasks)
      for (const test of await targeted(task.files))
        if (!inScope(test, task.files))
          for (const other of tasks)
            if (other !== task && inScope(test, other.files)) problems.push(`task "${task.id}": its targeted test ${test} is in task "${other.id}". Put them in one task.`)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return plan
}

/** True when `path` is the scope entry or inside it. */
const within = (path: string, entry: string) => path === entry.replace(/\/$/, '') || path.startsWith(`${entry.replace(/\/$/, '')}/`)

export const inScope = (path: string, files: string[]) => files.some((entry) => within(path, entry))

/** Reads the most builders at the same time from user input. Only an integer of 1 or more is valid. */
export function parseParallel(text: string): number {
  if (!/^\s*\d+\s*$/.test(text) || Number(text) < 1) throw new StopError(`--parallel must be an integer of 1 or more, not ${JSON.stringify(text)}`)
  return Number(text)
}

/** The issue that the PR of a local run closes. */
export function parseIssue(text: string): number {
  if (!/^\s*\d+\s*$/.test(text) || Number(text) < 1) throw new StopError(`--issue must be an issue number of 1 or more, not ${JSON.stringify(text)}`)
  return Number(text)
}

const overlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => within(x, y) || within(y, x)))

/**
 * The order of the builds: each wave holds tasks whose dependencies finished in earlier waves, at most `limit`,
 * with write scopes that do not overlap, so that they can run at the same time on their own branches.
 * Tasks in a cycle never become ready, so they are left out.
 */
export function waves(tasks: PlanTask[], limit: number): PlanTask[][] {
  const finished = new Set<string>()
  const left = [...tasks]
  const result: PlanTask[][] = []
  for (;;) {
    const wave: PlanTask[] = []
    for (const task of left)
      if (wave.length < limit && task.depends_on.every((id) => finished.has(id)) && !wave.some((other) => overlap(other.files, task.files))) wave.push(task)
    if (wave.length === 0) return result
    for (const task of wave) {
      finished.add(task.id)
      left.splice(left.indexOf(task), 1)
    }
    result.push(wave)
  }
}

export function renderPlan(plan: Plan, options: { tasks: boolean }): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`)
  return [
    '## Smallest change',
    '',
    plan.smallest_change,
    '',
    '## Goals',
    '',
    ...list(plan.goals),
    '',
    '## Non-goals',
    '',
    ...list(plan.non_goals),
    '',
    '## Done looks like',
    '',
    ...plan.done.map((item) => `- [ ] ${item.check}${item.command.trim() ? ` (\`${item.command}\`)` : ''}`),
    '',
    ...plan.sections.flatMap((section) => [`## ${section.name}`, '', section.text, '']),
    ...(options.tasks
      ? [
          '## Tasks',
          '',
          ...plan.tasks.flatMap((task) => [
            `### ${task.id}: ${task.title}`,
            '',
            `Files: ${task.files.map((path) => `\`${path}\``).join(', ')}${task.depends_on.length ? `. After: ${task.depends_on.join(', ')}` : ''}`,
            '',
            task.work,
            '',
          ]),
        ]
      : []),
  ].join('\n')
}

/** The frozen package for the review loop: the verbatim ask, the decisions of the user and of the run, and the plan without its tasks. */
export function frozenAsk(ask: string, decisions: Answer[], plan: Plan): string {
  return [
    ask.trim(),
    '',
    ...decisionLists(decisions, { user: '## Decisions of the user', run: '## Decisions the run made' }),
    '# Plan',
    '',
    renderPlan(plan, { tasks: false }),
  ].join('\n')
}
