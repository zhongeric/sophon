import type { Contracts } from 'nanocode-ts'
import { checkQuestions, questionsSchema, type Answer, type Question } from './questions.ts'
import { StopError } from './stop.ts'

/** What the intake agent understood of the ask, and how it routes the ask. */
export type Intake = {
  title: string
  summary: string
  slug: string
  /** A larger change gets a spec before the plan. */
  larger: boolean
  passes: 1 | 2
  reason: string
  questions: Question[]
}

export const submitIntake: Contracts.HostTool = {
  name: 'submit_intake',
  description:
    'Submit the intake one time: your summary of the ask, a PR title, a branch slug, the route (larger change, review passes) with the reason, and the questions that only the user can decide.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short PR title in the imperative, at most 72 characters' },
      summary: { type: 'string', description: 'The ask as you understand it, with the parts of the repository that it touches' },
      slug: { type: 'string', description: 'Lowercase words joined with hyphens, at most 40 characters, for example add-fee-switch' },
      larger: { type: 'boolean', description: 'True when the ask needs a spec before the plan' },
      passes: { type: 'integer', enum: [1, 2], description: 'Review loop passes: 2 for a larger feature set in Solidity src/, else 1' },
      reason: { type: 'string', description: 'Why you chose larger and passes, in one or two sentences' },
      questions: questionsSchema,
    },
    required: ['title', 'summary', 'slug', 'larger', 'passes', 'reason', 'questions'],
    additionalProperties: false,
  },
}

export function checkIntake(input: unknown): Intake {
  const intake = input as Intake
  const problems = [
    ...(!intake?.title?.trim() || intake.title.length > 72 ? ['title must have 1 to 72 characters'] : []),
    ...(!intake?.summary?.trim() ? ['summary is required'] : []),
    ...(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(intake?.slug ?? '') || intake.slug.length > 40 ? ['slug must be lowercase words joined with hyphens, at most 40 characters'] : []),
    ...(typeof intake?.larger !== 'boolean' ? ['larger must be true or false'] : []),
    ...(intake?.passes !== 1 && intake?.passes !== 2 ? ['passes must be 1 or 2'] : []),
    ...(!intake?.reason?.trim() ? ['reason is required'] : []),
  ]
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { ...intake, questions: checkQuestions({ questions: intake.questions }) }
}

export const confirmOptions = ['Yes, go on', 'No, stop the run']
export const specOptions = ['Write a spec first', 'Plan now']
export const passOptions = ['One pass', 'Two passes']

/** The host's questions after the intake agent's: confirm the ask, then the route. One batch, so one round trip. */
export function routeQuestions(intake: Intake): Question[] {
  const next = (offset: number) => `Q${intake.questions.length + offset}`
  return [
    { id: next(1), question: 'Is this the ask? Correct it in your own words if it is not.', why: intake.summary, options: confirmOptions, recommendation: confirmOptions[0]! },
    { id: next(2), question: 'Write a spec before the plan?', why: intake.reason, options: specOptions, recommendation: specOptions[intake.larger ? 0 : 1]! },
    { id: next(3), question: 'How many review loop passes?', why: intake.reason, options: passOptions, recommendation: passOptions[intake.passes - 1]! },
  ]
}

export type Route = { stop: boolean; spec: boolean; passes: 1 | 2 }

/**
 * Reads the route from the answers to the host's questions. Free text that corrects the ask becomes a decision for the planner.
 * A correction can start with "No,". The stop option, "no", "stop", and "stop the run" stop the run.
 */
export function route(intake: Intake, answers: Answer[]): Route {
  const [confirm, spec, passes] = routeQuestions(intake).map((question) => answers.find((answer) => answer.id === question.id)?.answer ?? question.recommendation)
  return {
    stop: confirm === confirmOptions[1] || /^\s*(no([\s,]+stop(\s+the\s+run)?)?|stop(\s+the\s+run)?)[.!]?\s*$/i.test(confirm!),
    spec: spec === specOptions[0] || /^\s*(yes|spec)\b/i.test(spec!),
    passes: passes === passOptions[1] || /\b(two|2)\b/i.test(passes!) ? 2 : 1,
  }
}

export type Spec = { spec: string; decisions: Question[] }

export const specSections = ['Summary', 'Surfaces', 'Edge cases', 'Out of scope', 'Decisions']

export const submitSpec: Contracts.HostTool = {
  name: 'submit_spec',
  description: `Submit the spec one time, in Markdown with the sections ${specSections.join(', ')}. Also submit each decision that the user can overrule as a question with options and your recommendation.`,
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
    'The host refuses a plan with an empty part, with no done check that has a command, or with tasks that depend on unknown tasks or on each other in a cycle.',
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

/** A task file without a leading `./` and without repeated slashes, so that it matches the paths of the repository. */
const normalizeFile = (path: string) => path.trim().replace(/\/{2,}/g, '/').replace(/^(\.\/)+(?=.)/, '')

/**
 * Refuses a plan without its four parts, its required sections, or tasks that the host can schedule.
 * Refuses task files that are protected. Returns the plan with the task files normalized.
 */
export function checkPlan(input: unknown, sections: string[], isProtectedPath: (path: string) => boolean = () => false): Plan {
  const plan = input as Plan
  const filled = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === 'string' && item.trim() !== '')
  const problems: string[] = []
  if (!plan?.smallest_change?.trim()) problems.push('smallest_change is empty')
  if (!filled(plan?.goals)) problems.push('goals is empty')
  if (!filled(plan?.non_goals)) problems.push('non_goals is empty')
  if (!Array.isArray(plan?.done) || !plan.done.some((item) => item?.check?.trim() && item.command?.trim())) problems.push('done needs at least one check with a command')
  for (const name of sections)
    if (!plan?.sections?.some((section) => section.name.trim().toLowerCase() === name.toLowerCase() && section.text.trim())) problems.push(`the plan needs the section "${name}"`)
  const tasks = (Array.isArray(plan?.tasks) ? plan.tasks : []).map((task) => (filled(task?.files) ? { ...task, files: task.files.map(normalizeFile) } : task))
  if (tasks.length === 0 || tasks.length > maxTasks) problems.push(`give 1 to ${maxTasks} tasks`)
  const ids = tasks.map((task) => task?.id)
  for (const task of tasks) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task?.id ?? '') || task.id.length > 30) problems.push(`task "${task?.id}": the ID must be lowercase words joined with hyphens, at most 30 characters`)
    if (ids.indexOf(task.id) !== ids.lastIndexOf(task.id)) problems.push(`task "${task.id}": the ID is not unique`)
    if (!task.title?.trim() || !task.work?.trim()) problems.push(`task "${task.id}": title and work are required`)
    if (!filled(task.files)) problems.push(`task "${task.id}": files is empty`)
    else
      for (const path of task.files) {
        if (/^\/|(^|\/)\.\.?(\/|$)/.test(path)) problems.push(`task "${task.id}": "${path}" must be relative to the repository root, without . or .., and not the root`)
        else if (isProtectedPath(path)) problems.push(`task "${task.id}": "${path}" is protected, and only the user can change it`)
      }
    if (!Array.isArray(task.depends_on)) problems.push(`task "${task.id}": depends_on must be a list`)
    else for (const id of task.depends_on) if (!ids.includes(id)) problems.push(`task "${task.id}": depends on the unknown task "${id}"`)
  }
  if (problems.length === 0 && waves(tasks, maxTasks).flat().length < tasks.length) problems.push('the tasks depend on each other in a cycle')
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { ...plan, tasks }
}

/** True when `path` is the scope entry or inside it. */
const within = (path: string, entry: string) => path === entry.replace(/\/$/, '') || path.startsWith(`${entry.replace(/\/$/, '')}/`)

export const inScope = (path: string, files: string[]) => files.some((entry) => within(path, entry))

/** Reads the most builders at the same time from user input. Only an integer of 1 or more is valid. */
export function parseParallel(text: string): number {
  if (!/^\s*\d+\s*$/.test(text) || Number(text) < 1) throw new StopError(`--parallel must be an integer of 1 or more, not ${JSON.stringify(text)}`)
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

/** The frozen package for the review loop: the verbatim ask, the user's decisions, and the plan without its tasks (ALL-040). */
export function frozenAsk(ask: string, decisions: Answer[], plan: Plan): string {
  return [
    ask.trim(),
    '',
    ...(decisions.length > 0 ? ['## Decisions of the user', '', ...decisions.map((answer) => `- ${answer.question} **${answer.answer}**`), ''] : []),
    '# Plan',
    '',
    renderPlan(plan, { tasks: false }),
  ].join('\n')
}
